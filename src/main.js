import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import app from './app.js';
import { config } from './config.js';
import { prepareDummyHash } from './auth/password.js';
import { logger } from './logging/logger.js';
import { closePool } from './db/pool.js';
import { lifecycle } from './lifecycle.js';
import { initMetrics } from './telemetry/metrics.js';
import { flushTelemetry } from './telemetry/shutdown.js';

const listen = (port) =>
  new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });

export const start = async () => {
  // Counters start at 0, so rate() works from the first event (see metrics.js)
  initMetrics();
  // Ready before the first request, so login timing is consistent from the start
  await prepareDummyHash();

  const server = await listen(config.port);
  const { port } = server.address();

  // Keep idle keep-alive connections open longer than a load balancer does
  // (AWS ALB: 60s). If the app closed first, the balancer could send a request
  // on a connection the app was closing, and the client would get a 502.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  // Give up on requests that take this long (Node's default is 5 minutes)
  server.requestTimeout = 30_000;

  // Requests in progress. During shutdown their keep-alive connections must be
  // closed once they finish: server.close() waits for every connection, and
  // Node keeps a finished request's connection open for the next request.
  const active = new Set();
  let shuttingDown = false; // signal received: new responses say "Connection: close"
  let closing = false; // no longer accepting connections: close idle ones as they free up
  // prependListener: runs before Express, which may answer synchronously
  server.prependListener('request', (req, res) => {
    active.add(res);
    if (shuttingDown) res.shouldKeepAlive = false; // sends "Connection: close"
    res.once('close', () => {
      active.delete(res);
      if (closing) server.closeIdleConnections();
    });
  });

  logger.info(
    { 'event.name': 'server.started', 'server.port': port, 'log.level': logger.level },
    `server listening on http://localhost:${port}`
  );

  // ------------------------------------------------------------ shutdown
  //
  // On SIGTERM (a deploy, docker stop, Kubernetes) or SIGINT (Ctrl+C):
  //   1. Readiness starts failing, so load balancers stop sending traffic.
  //   2. Optionally keep serving for SHUTDOWN_DELAY_MS while they notice.
  //   3. Stop accepting connections; let in-flight requests finish, for up to
  //      SHUTDOWN_TIMEOUT_MS, then close whatever is left.
  //   4. Close the database pool.
  //   5. Flush telemetry last, so the final requests' logs and traces are sent.
  // A second signal exits immediately.
  const shutdown = async (signal) => {
    if (shuttingDown) {
      logger.warn({ 'event.name': 'server.shutdown_forced', signal }, `${signal} again: exiting now`);
      process.exit(1);
    }
    shuttingDown = true;
    const started = performance.now();
    lifecycle.beginShutdown();
    // In-flight responses that haven't started sending: close their
    // connections afterwards instead of keeping them alive
    for (const res of active) if (!res.headersSent) res.shouldKeepAlive = false;
    logger.info(
      { 'event.name': 'server.shutdown_started', signal, 'app.requests_in_flight': active.size },
      `${signal} received: shutting down`
    );

    if (config.shutdown.delayMs) await sleep(config.shutdown.delayMs);

    // Stops accepting connections and closes idle keep-alive ones. Busy
    // connections close once their response is sent. (Not during the delay
    // above: then the app is still serving, and closing a connection a client
    // is about to reuse would reset its request.)
    closing = true;
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections();

    const timedOut = await Promise.race([closed.then(() => false), sleep(config.shutdown.timeoutMs).then(() => true)]);
    if (timedOut) {
      logger.warn(
        { 'event.name': 'server.shutdown_timeout', 'app.requests_in_flight': active.size },
        `requests still running after ${config.shutdown.timeoutMs}ms: closing their connections`
      );
      server.closeAllConnections();
      await closed;
    }

    await closePool();
    logger.info(
      { 'event.name': 'server.stopped', duration_ms: Math.round(performance.now() - started) },
      'server stopped'
    );
    await flushTelemetry();
    process.exit(0);
  };

  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(signal));
};

// ------------------------------------------------------------ crashes
//
// An error nothing caught means the process is in an unknown state, so it
// exits rather than carrying on. It logs at "fatal" first, with the stack, and
// flushes telemetry so the crash is visible in Grafana and not just a restart.
// Registered here, before start(), so startup failures are covered too.
let crashing = false;
const crash = (kind) => async (error) => {
  if (crashing) return;
  crashing = true;
  const err = error instanceof Error ? error : new Error(String(error));
  logger.fatal({ 'event.name': 'process.crashed', 'error.type': kind, err }, `${kind}: ${err.message}`);
  await flushTelemetry();
  process.exit(1);
};
process.on('uncaughtException', crash('uncaught exception'));
process.on('unhandledRejection', crash('unhandled promise rejection'));
