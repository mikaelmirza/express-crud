import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { createLogger } from '../src/logging/logger.js';
import { createHttpLogger, recordRoute } from '../src/logging/httpLogger.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { isDatabaseUnavailable } from '../src/db/errors.js';
import { metricReader } from './support/instrumentation.js';
import { resetStore, registerUser, PASSWORD } from './helpers.js';

const captureLogger = () => {
  const lines = [];
  const logger = createLogger({ level: 'debug', destination: { write: (l) => lines.push(JSON.parse(l)) } });
  return { logger, lines };
};

const limits = (overrides = {}) => ({
  enabled: true,
  windowMs: 60_000,
  max: 1000,
  authMax: 1000,
  shortSearchMax: 1000,
  ...overrides,
});

const rateLimitRejections = async (limiter) => {
  const { resourceMetrics } = await metricReader.collect();
  const points = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === 'app.rate_limit.rejections')?.dataPoints ?? [];
  return points.filter((p) => p.attributes['app.rate_limit.limiter'] === limiter).reduce((n, p) => n + p.value, 0);
};

describe('configuration', () => {
  it('applies defaults', () => {
    const c = parseConfig({});
    assert.equal(c.port, 3000);
    assert.equal(c.logLevel, 'info');
    assert.deepEqual(c.corsOrigins, []);
    assert.equal(c.trustProxy, false);
    assert.equal(c.rateLimit.enabled, true);
    assert.equal(c.db.connectTimeoutMs, 5000);
    assert.equal(c.shutdown.timeoutMs, 10_000);
  });

  it('lists every problem at once', () => {
    assert.throws(
      () => parseConfig({ PORT: 'abc', LOG_LEVEL: 'loud', DATABASE_URL: 'mysql://x', RATE_LIMIT_ENABLED: 'yes' }),
      (err) => {
        for (const name of ['PORT', 'LOG_LEVEL', 'DATABASE_URL', 'RATE_LIMIT_ENABLED']) assert.match(err.message, new RegExp(`- ${name}:`));
        return true;
      }
    );
  });

  it('parses CORS origins and rejects ones with paths', () => {
    assert.deepEqual(parseConfig({ CORS_ORIGINS: 'https://a.example.com, http://localhost:5173' }).corsOrigins, ['https://a.example.com', 'http://localhost:5173']);
    assert.deepEqual(parseConfig({ CORS_ORIGINS: '*' }).corsOrigins, ['*']);
    assert.throws(() => parseConfig({ CORS_ORIGINS: 'https://a.example.com/' }), /CORS_ORIGINS/);
    assert.throws(() => parseConfig({ CORS_ORIGINS: 'a.example.com' }), /CORS_ORIGINS/);
  });

  it('parses TRUST_PROXY forms', () => {
    assert.equal(parseConfig({ TRUST_PROXY: 'false' }).trustProxy, false);
    assert.equal(parseConfig({ TRUST_PROXY: 'true' }).trustProxy, true);
    assert.equal(parseConfig({ TRUST_PROXY: '2' }).trustProxy, 2);
    assert.equal(parseConfig({ TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).trustProxy, '10.0.0.0/8, 127.0.0.1');
    assert.throws(() => parseConfig({ TRUST_PROXY: 'yes please!' }), /TRUST_PROXY/);
  });

  it('accepts PORT=0 (any free port) and rejects out-of-range ports', () => {
    assert.equal(parseConfig({ PORT: '0' }).port, 0);
    assert.throws(() => parseConfig({ PORT: '70000' }), /PORT/);
  });
});

describe('health checks', () => {
  it('liveness is always ok and never cached', async () => {
    const app = createApp({ readinessCheck: async () => { throw new Error('db down'); } });
    for (const path of ['/health', '/health/live']) {
      const res = await request(app).get(path).expect(200);
      assert.deepEqual(res.body, { status: 'ok' });
      assert.equal(res.headers['cache-control'], 'no-store');
    }
  });

  it('readiness is ok when the database answers', async () => {
    const res = await request(createApp()).get('/health/ready').expect(200);
    assert.deepEqual(res.body, { status: 'ok', checks: { database: 'ok' } });
  });

  it('readiness fails with 503 and no details when the database check fails', async () => {
    const app = createApp({ readinessCheck: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:5432'); } });
    const res = await request(app).get('/health/ready').expect(503);
    assert.deepEqual(res.body, { status: 'unavailable', checks: { database: 'failed' } });
    assert.doesNotMatch(res.text, /ECONNREFUSED|5432/);
  });

  it('readiness fails while shutting down, without checking the database', async () => {
    let checked = false;
    const app = createApp({ lifecycle: { shuttingDown: true }, readinessCheck: async () => (checked = true) });
    const res = await request(app).get('/health/ready').expect(503);
    assert.deepEqual(res.body, { status: 'shutting_down' });
    assert.equal(checked, false);
  });

  it('logs readiness only when it changes, not on every check', async () => {
    const { logger, lines } = captureLogger();
    let healthy = true;
    const app = createApp({ logger, readinessCheck: async () => { if (!healthy) throw new Error('db down'); } });

    await request(app).get('/health/ready').expect(200);
    healthy = false;
    for (let i = 0; i < 3; i++) await request(app).get('/health/ready').expect(503);
    healthy = true;
    for (let i = 0; i < 2; i++) await request(app).get('/health/ready').expect(200);

    const events = lines.map((l) => l['event.name']).filter(Boolean);
    assert.deepEqual(events, ['health.not_ready', 'health.ready']);
    assert.equal(lines.find((l) => l['event.name'] === 'health.not_ready').err.message, 'db down');
  });

  it('is not rate limited', async () => {
    const app = createApp({ rateLimit: limits({ max: 2 }) });
    for (let i = 0; i < 5; i++) await request(app).get('/health/ready').expect(200);
  });
});

describe('security headers', () => {
  it('sets standard security headers and hides the framework', async () => {
    const res = await request(createApp()).get('/health/live');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.match(res.headers['strict-transport-security'], /max-age=/);
    assert.ok(res.headers['content-security-policy']);
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  it('rejects bodies over 100kb', async () => {
    const res = await request(createApp()).post('/api/auth/login').send({ email: 'a@example.com', password: 'x'.repeat(110_000) });
    assert.equal(res.status, 413);
  });
});

describe('CORS', () => {
  const app = createApp({ corsOrigins: ['https://app.example.com'] });

  it('allows listed origins and exposes the request id and rate-limit headers', async () => {
    const res = await request(app).get('/health/live').set('Origin', 'https://app.example.com');
    assert.equal(res.headers['access-control-allow-origin'], 'https://app.example.com');
    for (const header of ['X-Request-Id', 'RateLimit', 'Retry-After']) {
      assert.ok(res.headers['access-control-expose-headers'].includes(header), header);
    }
  });

  it('answers preflight requests for listed origins', async () => {
    const res = await request(app)
      .options('/api/items/123')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'DELETE')
      .set('Access-Control-Request-Headers', 'authorization,content-type')
      .expect(204);
    assert.match(res.headers['access-control-allow-methods'], /DELETE/);
    assert.match(res.headers['access-control-allow-headers'], /Authorization/);
  });

  it('sends no CORS headers for other origins', async () => {
    const res = await request(app).get('/health/live').set('Origin', 'https://evil.example.com');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  it('sends no CORS headers at all when no origins are configured', async () => {
    const res = await request(createApp({ corsOrigins: [] })).get('/health/live').set('Origin', 'https://app.example.com');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  it('allows any origin with *', async () => {
    const res = await request(createApp({ corsOrigins: ['*'] })).get('/health/live').set('Origin', 'https://anything.example.com');
    assert.equal(res.headers['access-control-allow-origin'], '*');
  });
});

describe('rate limiting', () => {
  beforeEach(resetStore);

  it('limits logins per IP, with Retry-After and RateLimit headers', async () => {
    const app = createApp({ rateLimit: limits({ authMax: 2 }) });
    const before = await rateLimitRejections('auth');
    const login = () => request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password' });

    await login().expect(401);
    await login().expect(401);
    const res = await login().expect(429);

    assert.equal(res.body.error, 'Too many requests');
    assert.equal(res.body.limit, 'auth');
    assert.ok(Number(res.headers['retry-after']) > 0);
    assert.equal(res.body.retryAfterSeconds, Number(res.headers['retry-after']));
    assert.match(res.headers.ratelimit, /"auth"; r=0/);
    assert.match(res.headers['ratelimit-policy'], /"auth"; q=2; w=60/);
    assert.equal(await rateLimitRejections('auth') - before, 1);
  });

  it('counts malformed login attempts toward the limit too', async () => {
    const app = createApp({ rateLimit: limits({ authMax: 2 }) });
    await request(app).post('/api/auth/login').send({}).expect(400);
    await request(app).post('/api/auth/login').send({ email: 'x' }).expect(400);
    await request(app).post('/api/auth/login').send({ email: 'a@example.com', password: PASSWORD }).expect(429);
  });

  it('shares the auth limit between login and register', async () => {
    const app = createApp({ rateLimit: limits({ authMax: 1 }) });
    await request(app).post('/api/auth/register').send({ email: 'shared@example.com', password: PASSWORD }).expect(201);
    await request(app).post('/api/auth/login').send({ email: 'shared@example.com', password: PASSWORD }).expect(429);
  });

  it('limits all /api requests per IP', async () => {
    const app = createApp({ rateLimit: limits({ max: 3 }) });
    for (let i = 0; i < 3; i++) await request(app).get('/api/items').expect(401);
    const res = await request(app).get('/api/items').expect(429);
    assert.equal(res.body.limit, 'api');
  });

  it('limits short searches per user, and only short searches', async () => {
    const app = createApp({ rateLimit: limits({ shortSearchMax: 2 }) });
    const alice = await registerUser();
    const bob = await registerUser();
    const search = (token, q) => request(app).get(`/api/items?q=${q}`).set('Authorization', `Bearer ${token}`);

    await search(alice.token, 'ab').expect(200);
    await search(alice.token, 'a').expect(200);
    const res = await search(alice.token, 'ab').expect(429);
    assert.equal(res.body.limit, 'short_search');

    await search(alice.token, 'abc').expect(200); // indexed: not limited
    await request(app).get('/api/items').set('Authorization', `Bearer ${alice.token}`).expect(200); // no search
    await search(bob.token, 'ab').expect(200); // another user has their own allowance
  });

  it('can be switched off', async () => {
    const app = createApp({ rateLimit: limits({ enabled: false, authMax: 1, max: 1 }) });
    for (let i = 0; i < 4; i++) {
      await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password' }).expect(401);
    }
  });

  it('logs a 429 once, as the request line at warn', async () => {
    const { logger, lines } = captureLogger();
    const app = createApp({ logger, rateLimit: limits({ authMax: 1 }) });
    await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password' });
    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password' }).expect(429);
    await sleep(20);

    const forRequest = lines.filter((l) => l.request_id === res.headers['x-request-id']);
    assert.equal(forRequest.length, 1);
    assert.equal(forRequest[0].level, 'warn');
    assert.equal(forRequest[0]['http.response.status_code'], 429);
  });
});

describe('errors', () => {
  // A nested router like the real app's, with a handler that fails
  const failingApp = (error) => {
    const { logger, lines } = captureLogger();
    const app = express();
    app.use(createHttpLogger(logger));
    const inner = express.Router();
    inner.get('/things/:id', recordRoute, () => {
      throw error;
    });
    const outer = express.Router();
    outer.use('/inner', inner);
    app.use('/api', outer);
    app.use(errorHandler);
    return { app, lines };
  };

  it('answers 503 with Retry-After when the database is unavailable', async () => {
    const { app } = failingApp(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }));
    const res = await request(app).get('/api/inner/things/1').expect(503);
    assert.equal(res.headers['retry-after'], '5');
    assert.deepEqual(res.body, { error: 'Service temporarily unavailable', requestId: res.headers['x-request-id'] });
  });

  it('answers 500 for other errors', async () => {
    const { app } = failingApp(new TypeError('oops'));
    const res = await request(app).get('/api/inner/things/1').expect(500);
    assert.equal(res.body.error, 'Internal Server Error');
    assert.equal(res.headers['retry-after'], undefined);
  });

  it('logs the full route pattern on errors from nested routers', async () => {
    const { app, lines } = failingApp(new TypeError('oops'));
    const res = await request(app).get('/api/inner/things/42').expect(500);
    await sleep(20);
    const line = lines.find((l) => l.request_id === res.headers['x-request-id']);
    assert.equal(line['http.route'], '/api/inner/things/:id');
    assert.equal(line.msg, 'GET /api/inner/things/:id 500');
  });

  it('recognizes database-unavailable errors', () => {
    const yes = [
      Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('x'), { code: 'ENOTFOUND' }),
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
      Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }),
      new Error('timeout exceeded when trying to connect'),
      new Error('Connection terminated due to connection timeout', { cause: new Error('Connection terminated unexpectedly') }),
      new Error('wrapped', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) }),
      new AggregateError([Object.assign(new Error('x'), { code: 'ECONNREFUSED' })], 'all addresses failed'),
    ];
    const no = [
      new TypeError('oops'),
      Object.assign(new Error('duplicate key'), { code: '23505' }),
      Object.assign(new Error('syntax error'), { code: '42601' }),
    ];
    for (const err of yes) assert.equal(isDatabaseUnavailable(err), true, err.message);
    for (const err of no) assert.equal(isDatabaseUnavailable(err), false, err.message);
  });
});
