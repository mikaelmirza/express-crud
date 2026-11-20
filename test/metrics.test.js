import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { metricReader } from './support/instrumentation.js';
import { api, anon, resetStore, registerUser, createItem, seed, PASSWORD } from './helpers.js';
import { initMetrics, searchCategory, LOGIN_OUTCOMES } from '../src/telemetry/metrics.js';

// All metrics currently held by the SDK: name -> data points
const collect = async () => {
  const { resourceMetrics, errors } = await metricReader.collect();
  assert.deepEqual(errors, []);
  const byName = new Map();
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const m of scope.metrics) byName.set(m.descriptor.name, m.dataPoints);
  }
  return byName;
};

// Metrics are cumulative for the whole test file, so tests compare values
// before and after the requests they make
const matches = (point, attributes) => Object.entries(attributes).every(([k, v]) => point.attributes[k] === v);
const sumOf = (points = [], attributes = {}) =>
  points.filter((p) => matches(p, attributes)).reduce((n, p) => n + (typeof p.value === 'number' ? p.value : p.value.count), 0);

const measure = async (name, attributes, action) => {
  const before = sumOf((await collect()).get(name), attributes);
  await action();
  await sleep(20); // http metrics are recorded when the response finishes
  return sumOf((await collect()).get(name), attributes) - before;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL = /@/;

describe('metrics', () => {
  beforeEach(resetStore);

  describe('custom metrics', () => {
    it('counts login attempts by outcome', async () => {
      await registerUser({ email: 'count@example.com' });
      const name = 'app.auth.login.attempts';
      const outcome = (o) => ({ 'app.auth.outcome': o });

      assert.equal(await measure(name, outcome('success'), () => anon().post('/api/auth/login').send({ email: 'count@example.com', password: PASSWORD }).expect(200)), 1);
      assert.equal(await measure(name, outcome('wrong_password'), () => anon().post('/api/auth/login').send({ email: 'count@example.com', password: 'wrong-password' }).expect(401)), 1);
      assert.equal(await measure(name, outcome('unknown_email'), () => anon().post('/api/auth/login').send({ email: 'ghost@example.com', password: 'wrong-password' }).expect(401)), 1);
    });

    it('does not count requests rejected by validation as login attempts', async () => {
      const delta = await measure('app.auth.login.attempts', {}, () => anon().post('/api/auth/login').send({ email: 'not-an-email', password: 'x' }).expect(400));
      assert.equal(delta, 0);
    });

    it('times password hashing and verification', async () => {
      const name = 'app.auth.password_hash.duration';
      assert.equal(await measure(name, { 'app.auth.operation': 'hash' }, () => registerUser({ email: 'time@example.com' })), 1);
      assert.equal(await measure(name, { 'app.auth.operation': 'verify' }, () => anon().post('/api/auth/login').send({ email: 'time@example.com', password: PASSWORD })), 1);

      const verify = (await collect()).get(name).find((p) => p.attributes['app.auth.operation'] === 'verify');
      assert.ok(verify.value.sum > 0, 'records a duration');
      assert.deepEqual(verify.value.buckets.boundaries, [0.05, 0.1, 0.25, 0.5, 0.75, 1, 2, 5, 10, 30]);
    });

    it('tracks hashes in progress, back to 0 when they finish', async () => {
      await Promise.all([registerUser(), registerUser(), registerUser()]);
      const active = (await collect()).get('app.auth.password_hash.active') ?? [];
      assert.ok(active.length > 0, 'metric exists');
      assert.equal(sumOf(active), 0);
    });

    it('times item lists by search category', async () => {
      const { token } = await registerUser();
      const name = 'app.items.list.duration';
      const category = (c) => ({ 'app.search.category': c });

      assert.equal(await measure(name, category('none'), () => api(token).get('/api/items').expect(200)), 1);
      assert.equal(await measure(name, category('short'), () => api(token).get('/api/items?q=la').expect(200)), 1);
      assert.equal(await measure(name, category('indexed'), () => api(token).get('/api/items?q=lamp').expect(200)), 1);
      assert.equal(await measure(name, category('none'), () => api(token).get('/api/items?q=').expect(200)), 1, 'blank q is no search');
    });

    it('counts registrations and created items', async () => {
      assert.equal(await measure('app.users.registered', {}, () => registerUser()), 1);
      assert.equal(await measure('app.items.created', {}, () => createItem({ name: 'counted' })), 1);
      assert.equal(await measure('app.items.created', {}, () => api().post('/api/items').send({}).expect(400)), 0, 'not for invalid input');
    });

    // In a fresh process: here, earlier tests' traffic has already created
    // most series, which would hide whether initMetrics() creates them
    const probe = async (env = {}, args = []) => {
      const { stdout } = await promisify(execFile)(process.execPath, ['test/support/metricsProbe.js', ...args], {
        env: { ...process.env, ...env },
      });
      return JSON.parse(stdout);
    };

    it('initMetrics reports every counter at 0, so rate() works from the first event', async () => {
      const series = await probe();
      const counters = series.filter((s) => s.name !== 'app.auth.password_hash.active');

      const outcomes = counters.filter((s) => s.name === 'app.auth.login.attempts').map((s) => s.attributes['app.auth.outcome']).sort();
      assert.deepEqual(outcomes, [...LOGIN_OUTCOMES].sort());
      assert.ok(counters.some((s) => s.name === 'app.users.registered'));
      assert.ok(counters.some((s) => s.name === 'app.items.created'));
      assert.ok(counters.every((s) => s.value === 0), 'all at 0');
    });

    it('initMetrics does not disturb counting afterwards', async () => {
      const series = await probe({}, ['--record']);
      const success = series.find((s) => s.name === 'app.auth.login.attempts' && s.attributes['app.auth.outcome'] === 'success');
      assert.equal(success.value, 1);
    });

    it('records nothing when custom telemetry is switched off (zero-code comparison)', async () => {
      assert.deepEqual(await probe({ APP_CUSTOM_TELEMETRY: 'false' }, ['--record']), []);
    });

    it('initMetrics is safe to call more than once', async () => {
      const before = await collect();
      initMetrics();
      initMetrics();
      const after = await collect();
      for (const name of ['app.auth.login.attempts', 'app.users.registered', 'app.items.created']) {
        assert.equal(sumOf(after.get(name)), sumOf(before.get(name)), `${name}: adds 0, changes nothing`);
      }
    });

    it('categorizes searches by whether the index can serve them', () => {
      assert.equal(searchCategory(undefined), 'none');
      assert.equal(searchCategory('a'), 'short');
      assert.equal(searchCategory('ab'), 'short');
      assert.equal(searchCategory('abc'), 'indexed');
    });
  });

  describe('automatic metrics', () => {
    it('records request duration by route pattern and status', async () => {
      const { token } = await registerUser();
      const name = 'http.server.request.duration';
      const delta = await measure(name, { 'http.route': '/api/items/:id', 'http.response.status_code': 404 }, () =>
        api(token).get('/api/items/00000000-0000-4000-8000-000000000000').expect(404)
      );
      assert.equal(delta, 1);

      const points = (await collect()).get(name);
      assert.ok(points.some((p) => p.attributes['http.request.method'] === 'GET'));
    });

    it('reports database pool usage, named after the database', async () => {
      await registerUser();
      const all = await collect();
      const used = all.get('db.client.connection.count') ?? [];
      assert.ok(used.some((p) => p.attributes['db.client.connection.state'] === 'used'));
      assert.ok(used.every((p) => p.attributes['db.client.connection.pool.name'] === 'localhost:5432/express_crud_test'));
      assert.ok(all.has('db.client.connection.pending_requests'));
      assert.ok(all.has('db.client.operation.duration'));
    });

    it('reports Node runtime metrics', async () => {
      await sleep(100);
      const all = await collect();
      for (const name of ['nodejs.eventloop.utilization', 'nodejs.eventloop.delay.p99', 'v8js.memory.heap.used']) {
        assert.ok(all.has(name), name);
      }
    });

    it('does not record /health', async () => {
      const delta = await measure('http.server.request.duration', {}, () => anon().get('/health').expect(200));
      assert.equal(delta, 0);
    });
  });

  describe('label cardinality', () => {
    // Every unique label combination is a separate time series stored forever.
    // These labels would create one per user, request, item or search.
    const FORBIDDEN_KEYS = ['user.id', 'enduser.id', 'app.request_id', 'url.path', 'url.query', 'url.full', 'http.target', 'app.search.query', 'email'];

    // Custom metrics may only use these labels
    const ALLOWED_CUSTOM_KEYS = {
      'app.auth.login.attempts': ['app.auth.outcome'],
      'app.auth.password_hash.duration': ['app.auth.operation'],
      'app.auth.password_hash.active': ['app.auth.operation'],
      'app.items.list.duration': ['app.search.category'],
      'app.users.registered': [],
      'app.items.created': [],
    };

    it('keeps ids, emails, URLs and search text out of every metric', async () => {
      // Varied traffic: several users, many distinct items, ids and searches
      const users = await Promise.all([registerUser(), registerUser(), registerUser()]);
      for (const { token } of users) {
        const items = await seed([{ name: 'alpha' }, { name: 'beta', price: 2 }], token);
        await api(token).get(`/api/items/${items[0].id}`).expect(200);
        await api(token).get('/api/items/00000000-0000-4000-8000-000000000000').expect(404);
        await api(token).get(`/api/items?q=secret-${Math.random()}&page=${1 + Math.floor(Math.random() * 9)}`).expect(200);
        await api(token).get('/api/items?q=ab').expect(200);
      }
      await anon().post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password' });
      await anon().get(`/random/${Math.random()}`);
      await sleep(20);

      const all = await collect();
      for (const [name, points] of all) {
        for (const point of points) {
          for (const [key, value] of Object.entries(point.attributes)) {
            assert.ok(!FORBIDDEN_KEYS.includes(key), `${name} has label ${key}`);
            const text = String(value);
            assert.doesNotMatch(text, UUID, `${name}.${key} contains an id: ${text}`);
            assert.doesNotMatch(text, EMAIL, `${name}.${key} contains an email: ${text}`);
            assert.ok(!text.includes('secret-'), `${name}.${key} contains search text`);
            assert.ok(!text.includes('/random/'), `${name}.${key} contains a raw URL`);
          }
        }
      }
    });

    it('uses only allowlisted labels on custom metrics', async () => {
      const { token } = await registerUser();
      await api(token).get('/api/items?q=lamp').expect(200);
      await createItem({ name: 'x' }, token);
      initMetrics();

      const all = await collect();
      for (const [name, allowed] of Object.entries(ALLOWED_CUSTOM_KEYS)) {
        assert.ok(all.has(name), `${name} exists`);
        for (const point of all.get(name)) {
          const keys = Object.keys(point.attributes).sort();
          assert.deepEqual(keys, [...allowed].sort(), `${name} labels`);
        }
      }
    });

    it('keeps request-duration series bounded however many distinct URLs are hit', async () => {
      const { token } = await registerUser();
      for (let i = 0; i < 25; i++) {
        await api(token).get(`/api/items/${crypto.randomUUID()}`);
        await anon().get(`/unknown-${i}`);
      }
      await sleep(20);
      const series = (await collect()).get('http.server.request.duration').length;
      assert.ok(series < 30, `${series} series for 50 distinct URLs`);
    });
  });
});
