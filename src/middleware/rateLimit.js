import { rateLimit } from 'express-rate-limit';
import { isHealthCheckPath } from '../healthPaths.js';
import { recordRateLimited, searchCategory } from '../telemetry/metrics.js';
import { setRequestAttributes } from '../telemetry/tracing.js';

const passThrough = (req, res, next) => next();

// Named, so traces show e.g. "middleware - rateLimitAuth" (not "<anonymous>")
// and a 429's trace says which limit stopped it
const named = (name, fn) => Object.defineProperty(fn, 'name', { value: name });

// Three limits, each protecting a different thing:
//
// - api:          every /api request, per client IP. General flood protection.
// - auth:         login and register, per client IP. Each costs ~0.37s of CPU
//                 for scrypt, so a few per second can saturate a small machine
//                 (see the metrics demo in the README). Also slows brute-forcing.
// - short_search: 1-2 character searches, per user. They can't use the trigram
//                 index and scan the table; 3+ character searches aren't limited.
//
// Counters live in memory, per process. With several instances behind a load
// balancer, each enforces its own limit; a shared store (e.g. Redis via
// rate-limit-redis) would make them global.
export const createRateLimiters = ({ enabled, windowMs, max, authMax, shortSearchMax }) => {
  if (!enabled) return { api: passThrough, auth: passThrough, shortSearch: passThrough };

  const limiter = (name, options) =>
    rateLimit({
      windowMs,
      // RateLimit and RateLimit-Policy headers (IETF draft 8), plus Retry-After when limited
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      identifier: name,
      handler: (req, res, next, opts) => {
        recordRateLimited(name);
        // No extra log line: the request's own line (429, level warn) records
        // it, and doubling log volume during a flood would make things worse
        setRequestAttributes({ 'app.rate_limit.limiter': name });
        res.status(opts.statusCode).json({
          error: 'Too many requests',
          limit: name,
          retryAfterSeconds: Number(res.getHeader('Retry-After')),
        });
      },
      ...options,
    });

  return {
    api: named('rateLimitApi', limiter('api', { limit: max, skip: (req) => isHealthCheckPath(req.path) })),
    auth: named('rateLimitAuth', limiter('auth', { limit: authMax })),
    // Runs after authentication and validation: keyed by user, sees the parsed q
    shortSearch: named(
      'rateLimitShortSearch',
      limiter('short_search', {
        limit: shortSearchMax,
        keyGenerator: (req) => req.user.id,
        skip: (req) => searchCategory(req.query.q) !== 'short',
      })
    ),
  };
};
