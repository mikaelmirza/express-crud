// Errors that mean "the database is unavailable right now", as opposed to a
// bug. They become 503 Service Unavailable with Retry-After, which clients and
// load balancers treat as temporary and retryable; a 500 says "broken".
//
// - Node network errors: refused, unreachable, reset, DNS failure
// - pg's connection timeouts (DB_CONNECT_TIMEOUT_MS), e.g. a hung database,
//   or a CPU so saturated that connecting takes too long
// - Postgres codes: 57014 statement timeout (DB_STATEMENT_TIMEOUT_MS),
//   57P01-57P03 server shutting down or starting, 53300 too many connections
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);
const POSTGRES_CODES = new Set(['57014', '57P01', '57P02', '57P03', '53300']);
const TIMEOUT_MESSAGES = [/timeout exceeded when trying to connect/i, /connection terminated due to connection timeout/i];

export const isDatabaseUnavailable = (err) => {
  for (let e = err; e; e = e.cause) {
    if (NETWORK_CODES.has(e.code) || POSTGRES_CODES.has(e.code)) return true;
    if (TIMEOUT_MESSAGES.some((pattern) => pattern.test(e.message ?? ''))) return true;
    // Node reports "connect to every address failed" as an AggregateError
    if (Array.isArray(e.errors) && e.errors.some(isDatabaseUnavailable)) return true;
  }
  return false;
};
