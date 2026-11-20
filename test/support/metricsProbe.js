// Run as a separate process by metrics.test.js. In the main test process,
// earlier traffic has already created most series, which would hide whether
// initMetrics() creates them. Here nothing else has run.
//
// Prints the custom metric series that exist after initMetrics(), as JSON.
import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';

class OnDemandMetricReader extends MetricReader {
  async onForceFlush() {}
  async onShutdown() {}
}

const reader = new OnDemandMetricReader();
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

// Imported after the provider is registered, as with --import in real runs
const { initMetrics, recordLoginAttempt } = await import('../../src/telemetry/metrics.js');

initMetrics();
if (process.argv.includes('--record')) recordLoginAttempt('success');

const { resourceMetrics } = await reader.collect();
const series = resourceMetrics.scopeMetrics.flatMap((s) =>
  s.metrics.flatMap((m) => m.dataPoints.map((p) => ({ name: m.descriptor.name, attributes: p.attributes, value: p.value })))
);
console.log(JSON.stringify(series));
