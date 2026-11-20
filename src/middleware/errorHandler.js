import { recordRequestError } from '../telemetry/tracing.js';
import { isDatabaseUnavailable } from '../db/errors.js';

// How long clients are told to wait before retrying when the database is unavailable
const RETRY_AFTER_SECONDS = 5;

export const notFound = (req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} not found` });
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  const unavailable = isDatabaseUnavailable(err);
  const status = unavailable ? 503 : err.status || 500;

  if (status >= 500) {
    // Attach the error to the response: the request logger adds it, with its
    // stack trace, to this request's single log line (logged at level "error").
    res.err = err;
    // Same for the trace: the request span is marked as an error with the
    // exception (type, message, stack) attached
    recordRequestError(err);
    // Never send internals (connection strings, SQL, stack traces) to the client.
    // The request id lets a user report the failure and us find its log line.
    if (unavailable) {
      res.set('Retry-After', String(RETRY_AFTER_SECONDS));
      return res.status(503).json({ error: 'Service temporarily unavailable', requestId: req.id });
    }
    return res.status(status).json({ error: 'Internal Server Error', requestId: req.id });
  }

  // Client errors (e.g. malformed JSON) aren't server faults: the request line
  // records them at level "warn", without a stack trace
  res.status(status).json({ error: err.message });
};
