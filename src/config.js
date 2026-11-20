// All server configuration, validated once at startup. A bad value stops the
// process with a list of every problem, instead of failing later (or silently
// falling back) on the first request that needs it.
//
// Auth settings (JWT_SECRET etc.) live in src/auth/config.js, so scripts that
// only need the database (migrations) don't require a JWT secret.
import { z } from 'zod';

const integer = (min, max) => z.coerce.number().int().min(min).max(max);

const booleanString = z
  .enum(['true', 'false'], { error: 'Expected "true" or "false"' })
  .transform((v) => v === 'true');

// "https://app.example.com,http://localhost:5173" -> ['https://app.example.com', 'http://localhost:5173']
const originList = z
  .string()
  .transform((value) => value.split(',').map((s) => s.trim()).filter(Boolean))
  .pipe(
    z.array(
      z.union([
        z.literal('*'),
        z.string().regex(/^https?:\/\/[^/\s?#]+$/, 'Each origin must look like https://host[:port], with no path or trailing slash'),
      ])
    )
  );

// Express's "trust proxy": how many proxies sit in front of the app, so the
// client's real IP is used for rate limiting and logs. "false" (default) for
// direct connections; "true" to trust every hop (only behind a trusted proxy);
// a number of hops; or a comma-separated list of proxy IPs / subnets.
const trustProxy = z.string().transform((value, ctx) => {
  if (value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  if (/^[\w.:/,\s-]+$/.test(value)) return value;
  ctx.addIssue({ code: 'custom', message: 'Expected false, true, a hop count, or proxy addresses' });
  return z.NEVER;
});

export const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 0 picks any free port (used by tests); the chosen port is logged at startup
  PORT: integer(0, 65535).default(3000),

  DATABASE_URL: z
    .string()
    .default('postgres://postgres:postgres@localhost:5432/express_crud')
    .refine((value) => {
      try {
        return ['postgres:', 'postgresql:'].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }, 'Expected a postgres:// connection URL'),
  DB_POOL_MAX: integer(1, 100).default(10),
  // How long to wait for a connection. pg's default is forever, so with the
  // database unreachable, every request would hang instead of failing.
  DB_CONNECT_TIMEOUT_MS: integer(100, 60_000).default(5000),
  // Postgres cancels any statement running longer than this (0 = no limit).
  // A safety net for runaway queries, like an unindexed search on a huge table.
  DB_STATEMENT_TIMEOUT_MS: integer(0, 600_000).default(10_000),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

  // Origins allowed to call the API from a browser. Empty (default): none,
  // so browsers block cross-origin calls. Non-browser clients aren't affected.
  CORS_ORIGINS: originList.default([]),
  TRUST_PROXY: trustProxy.default(false),

  RATE_LIMIT_ENABLED: booleanString.default(true),
  RATE_LIMIT_WINDOW_MS: integer(1000, 3_600_000).default(60_000),
  // Per client IP, per window
  RATE_LIMIT_MAX: integer(1, 1_000_000).default(300),
  RATE_LIMIT_AUTH_MAX: integer(1, 1_000_000).default(10),
  // Per user, per window: 1-2 character searches scan the table
  RATE_LIMIT_SHORT_SEARCH_MAX: integer(1, 1_000_000).default(20),

  // On SIGTERM/SIGINT: keep serving (readiness failing) for SHUTDOWN_DELAY_MS
  // so a load balancer stops sending traffic, then wait up to
  // SHUTDOWN_TIMEOUT_MS for in-flight requests before closing connections.
  SHUTDOWN_DELAY_MS: integer(0, 120_000).default(0),
  SHUTDOWN_TIMEOUT_MS: integer(0, 120_000).default(10_000),
});

// Formats zod issues as "  - NAME: message" lines
export const formatIssues = (issues) => issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');

// Parses an environment object. Exported for tests; the app uses `config`.
export const parseConfig = (env) => {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid configuration:\n${formatIssues(result.error.issues)}`);
  const c = result.data;
  return {
    env: c.NODE_ENV,
    port: c.PORT,
    db: {
      url: c.DATABASE_URL,
      poolMax: c.DB_POOL_MAX,
      connectTimeoutMs: c.DB_CONNECT_TIMEOUT_MS,
      statementTimeoutMs: c.DB_STATEMENT_TIMEOUT_MS,
    },
    logLevel: c.LOG_LEVEL,
    corsOrigins: c.CORS_ORIGINS,
    trustProxy: c.TRUST_PROXY,
    rateLimit: {
      enabled: c.RATE_LIMIT_ENABLED,
      windowMs: c.RATE_LIMIT_WINDOW_MS,
      max: c.RATE_LIMIT_MAX,
      authMax: c.RATE_LIMIT_AUTH_MAX,
      shortSearchMax: c.RATE_LIMIT_SHORT_SEARCH_MAX,
    },
    shutdown: { delayMs: c.SHUTDOWN_DELAY_MS, timeoutMs: c.SHUTDOWN_TIMEOUT_MS },
  };
};

// Blank values (FOO= in a .env file) mean "not set", so defaults apply
const withoutBlanks = (env) => Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));

export const config = parseConfig(withoutBlanks(process.env));
