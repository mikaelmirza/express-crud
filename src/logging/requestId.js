import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'X-Request-Id';

// Letters, digits, _ and -, up to 128 characters. Anything else (newlines,
// quotes, huge strings) is replaced, so clients can't forge or flood log lines.
const VALID_ID = /^[\w-]{1,128}$/;

// Reuses a safe incoming ID (e.g. from a load balancer or an upstream service)
// so one request can be followed across systems; otherwise makes a new one.
export const getRequestId = (req) => {
  const incoming = req.get?.(REQUEST_ID_HEADER) ?? req.headers?.['x-request-id'];
  return typeof incoming === 'string' && VALID_ID.test(incoming) ? incoming : randomUUID();
};
