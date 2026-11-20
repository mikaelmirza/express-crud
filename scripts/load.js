// Generates traffic so dashboards have something to show.
//
//   npm run load                        # mixed traffic, 60s, 10 concurrent
//   npm run load -- --duration 300      # longer run (seconds)
//   npm run load -- --concurrency 25
//   npm run load -- --logins            # parallel logins only: shows scrypt queueing
//
// Mixed traffic needs the demo user: run `npm run db:seed` first.
// Targets BASE_URL (default http://localhost:3000). Uses only Node's built-in fetch.

// Exit quietly if output is piped into something that closes early (`| head`)
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const DEMO = { email: 'demo@example.com', password: 'demo-password' };

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};

const loginsOnly = flag('logins');
const durationSec = option('duration', 60);
const concurrency = option('concurrency', loginsOnly ? 20 : 10);

let token;
const json = { 'content-type': 'application/json' };
const auth = () => ({ authorization: `Bearer ${token}` });

const login = async (password = DEMO.password) =>
  fetch(`${BASE_URL}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ ...DEMO, password }) });

// Short searches (1-2 characters) can't use the trigram index; 3+ can
const randomDigits = (n) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '1');

// [name, weight, request]. Weights roughly mimic a read-heavy app.
const MIXED = [
  ['list', 25, () => fetch(`${BASE_URL}/api/items?limit=20`, { headers: auth() })],
  ['search (indexed)', 25, () => fetch(`${BASE_URL}/api/items?q=${randomDigits(4)}`, { headers: auth() })],
  ['search (short)', 8, () => fetch(`${BASE_URL}/api/items?q=${randomDigits(2)}`, { headers: auth() })],
  ['sorted page', 10, () => fetch(`${BASE_URL}/api/items?sort=price&order=desc&page=${1 + Math.floor(Math.random() * 50)}`, { headers: auth() })],
  ['create', 8, () => fetch(`${BASE_URL}/api/items`, { method: 'POST', headers: { ...json, ...auth() }, body: JSON.stringify({ name: `Load test item ${Date.now()}`, price: Math.round(Math.random() * 10000) / 100 }) })],
  ['login', 5, () => login()],
  ['login (wrong password)', 3, () => login('wrong-password')],
  ['missing item (404)', 5, () => fetch(`${BASE_URL}/api/items/00000000-0000-4000-8000-000000000000`, { headers: auth() })],
  ['no token (401)', 5, () => fetch(`${BASE_URL}/api/items`)],
  ['invalid query (400)', 3, () => fetch(`${BASE_URL}/api/items?limit=500`, { headers: auth() })],
  ['unknown route (404)', 3, () => fetch(`${BASE_URL}/api/nope`)],
];
const LOGINS = [['login', 1, () => login()]];

const scenarios = loginsOnly ? LOGINS : MIXED;
const totalWeight = scenarios.reduce((sum, [, w]) => sum + w, 0);
const pick = () => {
  let r = Math.random() * totalWeight;
  for (const s of scenarios) if ((r -= s[1]) < 0) return s;
  return scenarios[0];
};

const stats = new Map(); // name -> { durations: [], statuses: Map, failures }
const record = (name, ms, status) => {
  const s = stats.get(name) ?? { durations: [], statuses: new Map(), failures: 0 };
  stats.set(name, s);
  if (status === 'failed') s.failures++;
  else {
    s.durations.push(ms);
    s.statuses.set(status, (s.statuses.get(status) ?? 0) + 1);
  }
};

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN);

const report = () => {
  const rows = [...stats].map(([name, s]) => {
    const sorted = [...s.durations].sort((a, b) => a - b);
    const statuses = [...s.statuses].map(([code, n]) => `${code}×${n}`).join(' ');
    return `  ${name.padEnd(24)} ${String(sorted.length).padStart(6)}  p50 ${percentile(sorted, 0.5).toFixed(0).padStart(5)} ms  p95 ${percentile(sorted, 0.95).toFixed(0).padStart(5)} ms  ${statuses}${s.failures ? `  failed×${s.failures}` : ''}`;
  });
  console.log(rows.join('\n'));
};

try {
  const res = await login();
  if (res.status !== 200) {
    throw new Error(`Couldn't log in as ${DEMO.email} (HTTP ${res.status}). Run \`npm run db:seed\` first.`);
  }
  token = (await res.json()).token;
} catch (err) {
  console.error(err.cause?.code === 'ECONNREFUSED' ? `Nothing is listening at ${BASE_URL}. Start the app first.` : err.message);
  process.exit(1);
}

const mode = loginsOnly ? 'logins only' : 'mixed traffic';
console.log(`${mode}: ${concurrency} concurrent for ${durationSec}s against ${BASE_URL} (Ctrl+C to stop early)`);

const deadline = Date.now() + durationSec * 1000;
let stopping = false;
process.once('SIGINT', () => (stopping = true));

let lastRefresh = Date.now();
const worker = async () => {
  while (!stopping && Date.now() < deadline) {
    // Access tokens last 15 minutes; refresh well before that on long runs
    if (Date.now() - lastRefresh > 10 * 60 * 1000) {
      lastRefresh = Date.now();
      token = (await (await login()).json()).token;
    }
    const [name, , run] = pick();
    const start = performance.now();
    try {
      const res = await run();
      await res.arrayBuffer(); // read the body so the connection is reused
      record(name, performance.now() - start, res.status);
    } catch {
      record(name, performance.now() - start, 'failed');
    }
  }
};

const started = Date.now();
const progress = setInterval(() => {
  const done = [...stats.values()].reduce((n, s) => n + s.durations.length + s.failures, 0);
  console.log(`  ${Math.round((Date.now() - started) / 1000)}s: ${done} requests`);
}, 10_000);

await Promise.all(Array.from({ length: concurrency }, worker));
clearInterval(progress);

const total = [...stats.values()].reduce((n, s) => n + s.durations.length + s.failures, 0);
const seconds = (Date.now() - started) / 1000;
console.log(`\n${total} requests in ${seconds.toFixed(0)}s (${(total / seconds).toFixed(1)}/s)\n`);
report();

// All traffic comes from one IP, so the per-IP rate limits soon kick in
const limited = [...stats.values()].reduce((n, s) => n + (s.statuses.get(429) ?? 0), 0);
if (limited > total * 0.2) {
  console.log(
    `\n${limited} of ${total} requests were rate limited (429). That's the limits working: all this traffic\n` +
      `comes from one IP. To load-test the app itself, set RATE_LIMIT_ENABLED=false in .env and restart it.`
  );
}
