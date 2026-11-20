// Test version of src/instrumentation.js, loaded with --import by `npm test`.
// Same instrumentations and options as the real setup, but spans and log
// records are kept in memory (exported synchronously) and metrics are read on
// demand, so tests can inspect real telemetry. Nothing is sent over the network.
import { register } from 'node:module';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SimpleSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { SimpleLogRecordProcessor, InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { MetricReader } from '@opentelemetry/sdk-metrics';
import { createInstrumentations } from '../../src/telemetry/instrumentations.js';

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

export const spanExporter = new InMemorySpanExporter();
export const logExporter = new InMemoryLogRecordExporter();

// Exports nothing on its own: tests call collect() to read current values
class OnDemandMetricReader extends MetricReader {
  async onForceFlush() {}
  async onShutdown() {}
}
export const metricReader = new OnDemandMetricReader();

const sdk = new NodeSDK({
  serviceName: 'express-crud-test',
  spanProcessors: [new SimpleSpanProcessor({ exporter: spanExporter })],
  logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
  metricReaders: [metricReader],
  instrumentations: createInstrumentations(),
});

sdk.start();
