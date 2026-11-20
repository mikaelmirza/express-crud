// Health checks run every few seconds and would bury real traffic, so they're
// left out of request logs, traces, metrics and rate limits. Shared by the app
// and the telemetry setup, so this file must stay dependency-free.
export const isHealthCheckPath = (path) => path === '/health' || path.startsWith('/health/');
