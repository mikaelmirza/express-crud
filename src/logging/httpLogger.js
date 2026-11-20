import { performance } from 'node:perf_hooks';
import pinoHttp from 'pino-http';
import { getRequestId, REQUEST_ID_HEADER } from './requestId.js';
import { serializeError } from './logger.js';
import { redactQuery } from './redaction.js';
import { setRequestAttributes } from '../telemetry/tracing.js';
import { isHealthCheckPath } from '../healthPaths.js';

const START = Symbol('requestStart');

const pathOf = (req) => (req.originalUrl ?? req.url).split('?')[0];
const queryOf = (req) => {
  const i = (req.originalUrl ?? req.url).indexOf('?');
  return i === -1 ? undefined : (req.originalUrl ?? req.url).slice(i + 1);
};

// The matched route pattern (/api/items/:id), not the actual URL. Dashboards
// group by this, and grouping by real URLs would make every id its own entry.
// Undefined when no route matched (404s, or a 401 from auth before routing).
const ROUTE = Symbol('matchedRoute');

const currentRoute = (req) => {
  if (!req.route) return undefined;
  const path = req.route.path === '/' ? '' : req.route.path;
  return `${req.baseUrl}${path}` || '/';
};

// First handler on every route: records the full pattern while it's known.
// When a handler passes an error on, Express leaves the nested routers and
// resets req.baseUrl before the error handler runs, so computing the route at
// log time would give "/login" instead of "/api/auth/login" on exactly the
// lines that matter most: 5xx errors.
export const recordRoute = function recordRoute(req, res, next) {
  req[ROUTE] = currentRoute(req);
  next();
};

export const routeOf = (req) => req[ROUTE] ?? currentRoute(req);

// One line per request, named with OpenTelemetry semantic conventions so the
// same queries work on logs and (from step 2) traces.
const requestFields = (req, res) => ({
  'http.request.method': req.method,
  'http.route': routeOf(req),
  'url.path': pathOf(req),
  'url.query': redactQuery(queryOf(req)),
  'http.response.status_code': res.statusCode,
  duration_ms: Math.round((performance.now() - req[START]) * 100) / 100,
  'user.id': req.user?.id,
});

const message = (req, res) => `${req.method} ${routeOf(req) ?? pathOf(req)} ${res.statusCode}`;

export const createHttpLogger = (logger) => {
  const middleware = pinoHttp({
    logger,
    // pino-http otherwise swaps in its default error serializer, undoing ours
    serializers: { err: serializeError },

    genReqId: (req, res) => {
      const id = getRequestId(req);
      res.setHeader(REQUEST_ID_HEADER, id);
      // So a request id quoted from a 500 finds the trace as well as the log line
      setRequestAttributes({ 'app.request_id': id });
      return id;
    },

    // req.log / res.log only carry request_id; the completion line is built
    // entirely by requestFields, so headers and bodies are never logged
    quietReqLogger: true,
    quietResLogger: true,
    customAttributeKeys: { reqId: 'request_id' },

    // Searching level="error" shows exactly the requests that failed on our side
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },

    customSuccessObject: (req, res) => requestFields(req, res),
    // err is set by the error handler (res.err) for 5xx responses
    customErrorObject: (req, res, err) => ({ ...requestFields(req, res), err }),
    customSuccessMessage: message,
    customErrorMessage: message,

    // Health checks: see healthPaths.js
    autoLogging: { ignore: (req) => isHealthCheckPath(pathOf(req)) },
  });

  // Named so traces show "middleware - requestLogger", not "<anonymous>"
  return function requestLogger(req, res, next) {
    req[START] = performance.now();
    middleware(req, res, next);
  };
};
