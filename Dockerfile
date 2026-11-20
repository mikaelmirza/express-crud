# syntax=docker/dockerfile:1

# Production image for express-crud.
#
#   docker build -t express-crud .
#   docker run -p 3000:3000 -e JWT_SECRET=... -e DATABASE_URL=... express-crud
#
# Or with the rest of the stack: npm run app:up (see README → Docker).

# ---- Stage 1: production dependencies only ---------------------------------
# A separate stage so npm's cache and the dev dependencies (test tools,
# pino-pretty, the zero-code bundle) never reach the final image. This layer
# is rebuilt only when package.json or package-lock.json change.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no dependency here needs an install script, and skipping
# them means a compromised package can't run code at build time
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# Files stay owned by root and the app runs as the unprivileged "node" user,
# so a compromised process can't modify its own code or dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Migrations and admin creation, for running inside the container:
#   docker compose exec app node scripts/migrate.js
COPY scripts/migrate.js scripts/create-admin.js ./scripts/

USER node
EXPOSE 3000

# "Healthy" means ready to serve: the readiness check, which includes the
# database. (Docker only reports health; it doesn't restart unhealthy
# containers. Orchestrators that do, like Kubernetes, should use
# /health/live for liveness and /health/ready for readiness.)
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/health/ready`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Node runs directly as PID 1, not through npm or a shell, so it receives
# SIGTERM from `docker stop` and shuts down gracefully (src/main.js). npm
# doesn't reliably forward signals, and a shell wouldn't forward them at all.
CMD ["node", "--import", "./src/instrumentation.js", "src/server.js"]
