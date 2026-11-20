// Flushes buffered telemetry (spans, logs, metrics) before the process exits.
//
// The SDK setup (src/instrumentation.js) publishes a flush function under this
// well-known key, so app code can call it without importing the SDK. With no
// SDK loaded (start:no-telemetry), or a different setup (zero-code, which
// flushes on SIGTERM itself), there's nothing to call and this resolves at once.
const FLUSH_KEY = Symbol.for('express-crud.telemetry.flush');

export const flushTelemetry = async () => {
  const flush = globalThis[FLUSH_KEY];
  if (typeof flush === 'function') await flush();
};
