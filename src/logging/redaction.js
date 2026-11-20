// Query parameters whose values are replaced with "REDACTED" wherever a URL
// is recorded: in log lines (url.query) and on trace spans (url.query).
//
// q is free text: people type names, emails, even passwords into search boxes.
// The rest are common credential parameter names, redacted defensively even
// though this API doesn't use them.
export const SENSITIVE_QUERY_PARAMS = ['q', 'token', 'access_token', 'api_key', 'password'];

export const REDACTED = 'REDACTED';

// "q=lamp&sort=price" -> "q=REDACTED&sort=price"
export const redactQuery = (query) => {
  if (!query) return query;
  const params = new URLSearchParams(query);
  let changed = false;
  for (const name of SENSITIVE_QUERY_PARAMS) {
    if (params.has(name)) {
      params.set(name, REDACTED);
      changed = true;
    }
  }
  return changed ? params.toString() : query;
};
