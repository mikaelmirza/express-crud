// OpenTelemetry SDK setup. Loaded before the app with Node's --import flag:
//
//   node --import ./src/instrumentation.js src/server.js
//
// It has to run first because instrumentation works by patching Express, pg,
// http and pino as they're loaded. Application code never imports this file:
// what's collected, where it's sent and how it's sampled is a deployment
// concern, configured with the standard OTEL_* environment variables, e.g.
//
//   OTEL_EXPORTER_OTLP_ENDPOINT   where to send data (default http://localhost:4318)
//   OTEL_SERVICE_NAME             overrides the service name below
//   OTEL_TRACES_SAMPLER(_ARG)     sampling (default: record everything)
//   OTEL_METRIC_EXPORT_INTERVAL   ms between metric exports (default here: 10000)
//   OTEL_SDK_DISABLED=true        turns all of this off
//   OTEL_LOG_LEVEL=debug          the SDK's own diagnostics (silent by default)
import { register } from 'node:module';
import { createRequire } from 'node:module';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { HostMetrics } from '@opentelemetry/host-metrics';
import { metrics } from '@opentelemetry/api';
import { createInstrumentations } from './telemetry/instrumentations.js';

// The loader hook lets instrumentation patch modules imported as ES modules.
// Express and pg are still patched without it (Node loads those CommonJS
// packages through require), but pino isn't: log lines would lose their
// trace_id and no logs would be exported. Any ESM-only library would also be
// missed entirely.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

const { name, version } = createRequire(import.meta.url)('../package.json');

const sdk = new NodeSDK({
  serviceName: name,
  resource: resourceFromAttributes({
    'service.version': version,
    'deployment.environment.name': process.env.NODE_ENV ?? 'development',
  }),
  // Batched in the background: requests never wait on telemetry, and if the
  // collector is down, data is dropped quietly rather than failing requests
  spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })],
  logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  // Metrics are pushed every 10 seconds. The OpenTelemetry default is 60,
  // which makes a dashboard lag a minute behind while you watch it.
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL) || 10_000,
    }),
  ],
  instrumentations: createInstrumentations(),
});

sdk.start();

// CPU and memory for the process and the machine. CPU is the resource scrypt
// competes for: on a 2-core machine a few logins per second fill it and slow
// every other request. (Network metrics are skipped: one series per device.)
new HostMetrics({
  meterProvider: metrics.getMeterProvider(),
  metricGroups: ['process.cpu', 'process.memory', 'system.cpu', 'system.memory'],
}).start();

// Batches are sent every few seconds, so stopping the process would lose the
// last ones. The app owns shutdown (src/server.js): it stops taking requests,
// lets in-flight ones finish, closes the database pool, and only then calls
// this flush, so telemetry from the final requests is included. It's published
// under a well-known global key so app code can call it without importing the SDK.
//
// The flush is capped: with no collector running, the exporter retries for
// ~9 seconds before giving up, which would make every Ctrl+C hang.
const FLUSH_TIMEOUT_MS = 2000;

let flushing;
globalThis[Symbol.for('express-crud.telemetry.flush')] = () =>
  (flushing ??= Promise.race([
    sdk.shutdown().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS).unref()),
  ]));
