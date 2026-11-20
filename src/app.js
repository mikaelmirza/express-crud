import express from 'express';
import { config } from './config.js';
import { createRoutes } from './routes/index.js';
import { createHealthRoutes } from './routes/health.routes.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import { securityHeaders, corsPolicy } from './middleware/security.js';
import { createRateLimiters } from './middleware/rateLimit.js';
import { logger as defaultLogger } from './logging/logger.js';
import { createHttpLogger } from './logging/httpLogger.js';
import { lifecycle as defaultLifecycle } from './lifecycle.js';

// A factory so tests can build an app with their own logger, limits, CORS
// origins, readiness check or shutdown state. Defaults come from config.
export const createApp = ({
  logger = defaultLogger,
  rateLimit = config.rateLimit,
  corsOrigins = config.corsOrigins,
  trustProxy = config.trustProxy,
  readinessCheck,
  lifecycle = defaultLifecycle,
} = {}) => {
  const app = express();

  // Use the client's real IP (for rate limits) when behind a proxy; see config.js
  app.set('trust proxy', trustProxy);

  // First, so every request (including rejected ones) gets an id and a log line
  app.use(createHttpLogger(logger));
  app.use(securityHeaders());
  const cors = corsPolicy(corsOrigins);
  if (cors) app.use(cors);

  // Health checks: no auth, no rate limit, not logged or traced
  app.use('/health', createHealthRoutes({ readinessCheck, lifecycle, logger }));

  const limiters = createRateLimiters(rateLimit);
  // Before body parsing, so a flood is rejected without reading bodies
  app.use('/api', limiters.api);
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', createRoutes({ limiters }));

  app.use(notFound);
  app.use(errorHandler);

  return app;
};

export default createApp();
