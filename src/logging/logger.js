import pino from 'pino';
import { createRequire } from 'node:module';
import { config } from '../config.js';

const { name, version } = createRequire(import.meta.url)('../../package.json');

// Defense in depth: request/response bodies and headers are never logged, but
// if any of these fields ever reach a log call, they're replaced before writing.
const REDACT_PATHS = [
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'authorization',
  'cookie',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.token',
  '*.authorization',
  '*.cookie',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
];

// Error fields dropped from logs:
// - detail: Postgres puts row values here ("Key (email)=(bob@example.com) already exists")
const DROPPED_ERROR_FIELDS = new Set(['detail']);

// Pino's standard error serializer keeps every property, so a pg error drags in
// its whole Client object (connection settings, internal cancel key, sockets).
// Keep the error's own simple fields (message, stack, code, errno, severity...),
// drop any attached objects, and recurse into `cause` chains.
export const serializeError = (err) => {
  if (!(err instanceof Error)) return err;
  const out = pino.stdSerializers.err(err);
  for (const [key, value] of Object.entries(out)) {
    if (key === 'cause' || key === 'aggregateErrors') continue;
    if (DROPPED_ERROR_FIELDS.has(key) || (value !== null && typeof value === 'object')) delete out[key];
  }
  if (err.cause instanceof Error) out.cause = serializeError(err.cause);
  if (Array.isArray(err.errors)) out.aggregateErrors = err.errors.map(serializeError);
  return out;
};

// Creates a logger that writes JSON lines. The app uses the default instance
// below; tests create their own with an in-memory destination to read output.
// For readable local output, `npm run dev` pipes these lines into pino-pretty.
export const createLogger = ({ level = config.logLevel, destination } = {}) => {
  const options = {
    level,
    // OpenTelemetry resource attribute names, so logs and traces line up
    base: { 'service.name': name, 'service.version': version },
    timestamp: pino.stdTimeFunctions.isoTime,
    // "info" instead of 30: Loki and Grafana filter on level names
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: { err: serializeError },
  };

  return destination ? pino(options, destination) : pino(options);
};

export const logger = createLogger();
