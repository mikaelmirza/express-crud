// Which libraries are instrumented, and how. Part of the telemetry *setup*
// (a deployment concern): loaded by src/instrumentation.js and by the test
// setup, never by application code.
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { SENSITIVE_QUERY_PARAMS } from '../logging/redaction.js';
import { isHealthCheckPath } from '../healthPaths.js';

// The http instrumentation's built-in list (signed cloud-storage URLs).
// Setting our own list replaces it, so it's repeated here.
const DEFAULT_REDACTED_QUERY_PARAMS = [
  'sig',
  'Signature',
  'AWSAccessKeyId',
  'X-Goog-Signature',
  'X-Amz-Signature',
  'X-Amz-Credential',
  'X-Amz-Security-Token',
];

// Express's own internal layers: real but uninteresting, ~0ms each
const NOISY_EXPRESS_LAYERS = ['query', 'expressInit', 'jsonParser', 'requestLogger', 'recordRoute', 'helmetMiddleware', 'corsMiddleware'];

export const createInstrumentations = ({ logSending = true } = {}) => [
  // The server span for each request: method, route, status, duration.
  // Also continues an incoming W3C `traceparent` instead of starting a new trace.
  new HttpInstrumentation({
    // Health checks: see healthPaths.js (same as the request logs)
    ignoreIncomingRequestHook: (req) => isHealthCheckPath((req.url ?? '').split('?')[0]),
    // Same redaction as the request logs: search text never reaches a span.
    // Outgoing requests too, for any HTTP calls the app makes in future.
    redactedQueryParamsServer: [...DEFAULT_REDACTED_QUERY_PARAMS, ...SENSITIVE_QUERY_PARAMS],
    redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS, ...SENSITIVE_QUERY_PARAMS],
  }),

  // Spans for the middleware and handlers a request passes through. Router
  // layers are skipped: they take ~0ms and this instrumentation version names
  // them confusingly (the /api router shows up as "router - /register").
  new ExpressInstrumentation({
    ignoreLayers: NOISY_EXPRESS_LAYERS.map((name) => `middleware - ${name}`),
    ignoreLayersType: ['router'],
  }),

  // A span per query with the SQL text, plus spans for waiting on a pool
  // connection. Explicitly off: "enhanced" reporting records parameter values,
  // which here include password hashes (register) and emails (login).
  new PgInstrumentation({ enhancedDatabaseReporting: false }),

  // Adds trace_id / span_id / trace_flags to every log line, and (unless
  // disabled) also sends log records over OTLP so Grafana can link them to traces
  new PinoInstrumentation({ disableLogSending: !logSending }),

  // Node runtime metrics: event loop delay and utilization, heap, GC.
  // Event loop delay is the key Node health signal: one slow synchronous
  // operation stalls every request at once.
  new RuntimeNodeInstrumentation(),
];
