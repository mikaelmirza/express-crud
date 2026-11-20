// Smoke test against a running server: the main paths work end to end.
// Used by CI against the Docker image; also handy locally.
//
//   npm run smoke                          # http://localhost:3000
//   BASE_URL=https://staging.example.com npm run smoke
//
// Registers a throwaway user, so don't point it at a database you care about.
// Exits 1 on the first failure.

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const json = { 'content-type': 'application/json' };

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
  return ok;
};

const call = async (method, path, { body, token } = {}) => {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { ...(body && json), ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, headers: res.headers, data };
};

try {
  const live = await call('GET', '/health/live');
  check('liveness', live.status === 200, `HTTP ${live.status}`);

  const ready = await call('GET', '/health/ready');
  check('readiness (database reachable)', ready.status === 200, JSON.stringify(ready.data));
  check('security headers', ready.headers.get('x-content-type-options') === 'nosniff');

  const email = `smoke-${Date.now()}@example.com`;
  const password = 'smoke-test-password';
  const reg = await call('POST', '/api/auth/register', { body: { email, password } });
  check('register', reg.status === 201, `HTTP ${reg.status} ${JSON.stringify(reg.data)}`);
  check('request id header', /^[\w-]+$/.test(reg.headers.get('x-request-id') ?? ''));

  const login = await call('POST', '/api/auth/login', { body: { email, password } });
  const token = login.data?.token;
  if (!check('login', login.status === 200 && token, `HTTP ${login.status}`)) throw new Error('cannot continue without a token');

  const created = await call('POST', '/api/items', { token, body: { name: 'smoke test lamp', price: 12.5 } });
  check('create item', created.status === 201, `HTTP ${created.status}`);

  const listed = await call('GET', '/api/items?q=smoke', { token });
  check('list and search', listed.status === 200 && listed.data.data?.some((i) => i.id === created.data.id), `HTTP ${listed.status}`);

  const removed = await call('DELETE', `/api/items/${created.data.id}`, { token });
  check('delete item', removed.status === 204, `HTTP ${removed.status}`);

  const anon = await call('GET', '/api/items');
  check('rejects missing token', anon.status === 401, `HTTP ${anon.status}`);

  const invalid = await call('GET', '/api/items?limit=500', { token });
  check('rejects invalid input', invalid.status === 400, `HTTP ${invalid.status}`);
} catch (err) {
  const reason = err.cause?.code === 'ECONNREFUSED' ? `nothing is listening at ${BASE_URL}` : err.message;
  check('smoke test ran', false, reason);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
