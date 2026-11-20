// The only telemetry module application code imports.
//
// It uses @opentelemetry/api (plus one helper from @opentelemetry/core) and
// never the SDK. Which SDK runs, where data goes and how it's sampled are
// deployment concerns, set up in src/instrumentation.js or attached by ops.
// With no SDK loaded, every call here does nothing, so tests and
// telemetry-off runs work unchanged.
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { getRPCMetadata } from '@opentelemetry/core';
import { createRequire } from 'node:module';

const { name, version } = createRequire(import.meta.url)('../../package.json');

// Custom spans and attributes can be switched off. This exists only for the
// zero-code comparison (see README): it shows what automatic instrumentation
// gives you on its own. A real app wouldn't need it.
const enabled = process.env.APP_CUSTOM_TELEMETRY !== 'false';

const tracer = trace.getTracer(name, version);

// Runs fn inside a new child span. The span ends when fn settles; a thrown
// error is recorded on the span and rethrown.
export const withSpan = async (spanName, attributes, fn) => {
  if (!enabled) return fn();
  return tracer.startActiveSpan(spanName, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
};

// The request's server span (the root span for an incoming request).
// Inside middleware, the "active" span is that middleware's own span, so
// request-level attributes would land in the wrong place. The http
// instrumentation stores the server span in the request's context, where
// the express instrumentation also finds it to set http.route.
const requestSpan = () => getRPCMetadata(context.active())?.span ?? trace.getActiveSpan();

// Adds attributes to the current request's server span. Undefined values are skipped.
export const setRequestAttributes = (attributes) => {
  if (!enabled) return;
  const span = requestSpan();
  if (!span) return;
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) span.setAttribute(key, value);
  }
};

// Marks the current request as failed, with the exception attached.
// Only for 5xx: OpenTelemetry conventions don't treat 4xx as server errors.
export const recordRequestError = (err) => {
  if (!enabled) return;
  const span = requestSpan();
  if (!span) return;
  span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
};
