import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createLogger, serializeError } from '../src/logging/logger.js';
import { createHttpLogger } from '../src/logging/httpLogger.js';
import { redactQuery } from '../src/logging/redaction.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { resetStore, registerUser, PASSWORD } from './helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A logger that keeps every line in memory, parsed
const captureLogger = () => {
  const lines = [];
  const logger = createLogger({
    level: 'debug',
    destination: { write: (chunk) => lines.push(JSON.parse(chunk)) },
  });
  return { logger, lines };
};

// The request line is written when the response finishes, which can be just
// after the client has the response. Wait briefly for it.
const waitForLine = async (lines, predicate, timeoutMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = lines.find(predicate);
    if (line) return line;
    await sleep(5);
  }
  assert.fail('expected log line was not written');
};

const requestLine = (lines, requestId) =>
  waitForLine(lines, (l) => l.request_id === requestId && 'http.response.status_code' in l);

describe('logging', () => {
  let lines;
  let app;

  // A real app wired to a capturing logger; the DB is reset before each test
  beforeEach(async () => {
    await resetStore();
    const capture = captureLogger();
    app = createApp({ logger: capture.logger });
    lines = capture.lines;
  });

  describe('request ids', () => {
    it('generates an id, returns it in X-Request-Id, and logs it', async () => {
      const res = await request(app).get('/nope').expect(404);
      const id = res.headers['x-request-id'];

      assert.match(id, UUID);
      assert.ok(await requestLine(lines, id));
    });

    it('reuses a valid incoming id', async () => {
      const res = await request(app).get('/nope').set('X-Request-Id', 'upstream-abc_123');
      assert.equal(res.headers['x-request-id'], 'upstream-abc_123');
      assert.ok(await requestLine(lines, 'upstream-abc_123'));
    });

    for (const [label, value] of [
      ['too long', 'x'.repeat(129)],
      ['containing spaces', 'abc def'],
      ['containing quotes', 'abc"def'],
      ['containing JSON', '{"level":"error"}'],
    ]) {
      it(`replaces an incoming id ${label}`, async () => {
        const res = await request(app).get('/nope').set('X-Request-Id', value);
        assert.match(res.headers['x-request-id'], UUID);
      });
    }

    it('gives each request its own id', async () => {
      const a = await request(app).get('/nope');
      const b = await request(app).get('/nope');
      assert.notEqual(a.headers['x-request-id'], b.headers['x-request-id']);
    });
  });

  describe('request lines', () => {
    it('logs one line per request with OpenTelemetry field names', async () => {
      const { user, token } = await registerUser();
      const res = await request(app)
        .get('/api/items?q=lamp&sort=price')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const line = await requestLine(lines, res.headers['x-request-id']);
      assert.equal(line.level, 'info');
      assert.equal(line.msg, 'GET /api/items 200');
      assert.equal(line['service.name'], 'express-crud');
      assert.equal(line['http.request.method'], 'GET');
      assert.equal(line['http.route'], '/api/items');
      assert.equal(line['url.path'], '/api/items');
      assert.equal(line['url.query'], 'q=REDACTED&sort=price', 'search text is redacted');
      assert.equal(line['http.response.status_code'], 200);
      assert.equal(line['user.id'], user.id);
      assert.equal(typeof line.duration_ms, 'number');
      assert.ok(line.duration_ms >= 0);
      assert.match(line.time, /^\d{4}-\d{2}-\d{2}T/);

      const forRequest = lines.filter((l) => l.request_id === res.headers['x-request-id']);
      assert.equal(forRequest.length, 1, 'exactly one line for a plain request');
    });

    it('logs the route pattern, not the actual id', async () => {
      const { token } = await registerUser();
      const id = '00000000-0000-4000-8000-000000000000';
      const res = await request(app).get(`/api/items/${id}`).set('Authorization', `Bearer ${token}`);

      const line = await requestLine(lines, res.headers['x-request-id']);
      assert.equal(line['http.route'], '/api/items/:id');
      assert.equal(line['url.path'], `/api/items/${id}`);
      assert.equal(line.msg, 'GET /api/items/:id 404');
    });

    it('logs 4xx at warn, without an error or stack', async () => {
      const res = await request(app).get('/nope').expect(404);
      const line = await requestLine(lines, res.headers['x-request-id']);
      assert.equal(line.level, 'warn');
      assert.equal(line.err, undefined);
      assert.equal(line['http.route'], undefined, 'no route matched');
    });

    it('logs malformed JSON as a 400 warning', async () => {
      const res = await request(app)
        .post('/api/items')
        .set('content-type', 'application/json')
        .send('{"name":');
      const line = await requestLine(lines, res.headers['x-request-id']);
      assert.equal(line.level, 'warn');
      assert.equal(line['http.response.status_code'], 400);
    });

    it('does not log /health', async () => {
      const res = await request(app).get('/health').expect(200);
      assert.ok(res.headers['x-request-id'], 'still gets an id');
      await sleep(50);
      assert.equal(lines.length, 0);
    });
  });

  describe('server errors', () => {
    // A tiny app with a failing route, wired like the real one
    const failingApp = (logger) => {
      const a = express();
      a.use(createHttpLogger(logger));
      a.get('/boom/:id', () => {
        // A plain bug (database-unavailable errors are 503s, tested separately)
        throw Object.assign(new TypeError("Cannot read properties of undefined (reading 'id')"), { code: 'ERR_TEST' });
      });
      a.use(errorHandler);
      return a;
    };

    it('logs 5xx at error with the error and stack, in the same single line', async () => {
      const capture = captureLogger();
      const res = await request(failingApp(capture.logger)).get('/boom/42').expect(500);
      const id = res.headers['x-request-id'];

      const line = await requestLine(capture.lines, id);
      assert.equal(line.level, 'error');
      assert.equal(line['http.route'], '/boom/:id');
      assert.equal(line.err.message, "Cannot read properties of undefined (reading 'id')");
      assert.equal(line.err.type, 'TypeError');
      assert.equal(line.err.code, 'ERR_TEST');
      assert.match(line.err.stack, /at /);
      assert.equal(capture.lines.filter((l) => l.request_id === id).length, 1);
    });

    it('returns the request id in the 500 body and nothing internal', async () => {
      const capture = captureLogger();
      const res = await request(failingApp(capture.logger)).get('/boom/1').expect(500);

      assert.deepEqual(res.body, { error: 'Internal Server Error', requestId: res.headers['x-request-id'] });
      assert.doesNotMatch(res.text, /TypeError|reading|at /);
    });
  });

  describe('auth events', () => {
    it('logs user.registered with the same request_id as the request line', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'events@example.com', password: PASSWORD })
        .expect(201);
      const id = res.headers['x-request-id'];

      const event = await waitForLine(lines, (l) => l['event.name'] === 'user.registered');
      assert.equal(event.request_id, id);
      assert.equal(event['user.id'], res.body.user.id);
      assert.ok(await requestLine(lines, id));
    });

    it('logs failed logins with a reason, and the user id only when known', async () => {
      const { user } = await registerUser({ email: 'known@example.com' });

      await request(app).post('/api/auth/login').send({ email: 'known@example.com', password: 'wrong-password' });
      await request(app).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'wrong-password' });

      const failures = [];
      await waitForLine(lines, (l) => {
        if (l['event.name'] === 'auth.login_failed' && !failures.includes(l)) failures.push(l);
        return failures.length === 2;
      });

      assert.deepEqual(
        failures.map((f) => [f.reason, f['user.id']]),
        [['wrong_password', user.id], ['unknown_email', undefined]]
      );
    });

    it('logs successful logins', async () => {
      const { user } = await registerUser({ email: 'ok@example.com' });
      await request(app).post('/api/auth/login').send({ email: 'ok@example.com', password: PASSWORD }).expect(200);

      const event = await waitForLine(lines, (l) => l['event.name'] === 'auth.login_succeeded');
      assert.equal(event['user.id'], user.id);
    });
  });

  describe('secrets and personal data', () => {
    it('never logs passwords, tokens, hashes, auth headers or emails', async () => {
      const email = 'secret-check@example.com';
      const reg = await request(app).post('/api/auth/register').send({ email, password: PASSWORD }).expect(201);
      const { token } = reg.body;

      await request(app).post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
      await request(app).post('/api/auth/login').send({ email, password: 'wrong-password' }).expect(401);
      const last = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
      await requestLine(lines, last.headers['x-request-id']);

      const all = JSON.stringify(lines);
      assert.ok(lines.length >= 7, 'sanity check: lines were captured');
      for (const secret of [PASSWORD, 'wrong-password', token, 'Bearer', 'scrypt$', email]) {
        assert.ok(!all.includes(secret), `log output contains ${secret}`);
      }
    });

    it('redacts sensitive fields if they are ever passed to the logger', () => {
      const capture = captureLogger();
      capture.logger.info({
        password: 'p1',
        token: 't1',
        user: { passwordHash: 'h1', token: 't2' },
        headers: { authorization: 'Bearer abc', cookie: 'sid=1', accept: 'json' },
      });

      const [line] = capture.lines;
      assert.equal(line.password, '[REDACTED]');
      assert.equal(line.token, '[REDACTED]');
      assert.equal(line.user.passwordHash, '[REDACTED]');
      assert.equal(line.user.token, '[REDACTED]');
      assert.equal(line.headers.authorization, '[REDACTED]');
      assert.equal(line.headers.cookie, '[REDACTED]');
      assert.equal(line.headers.accept, 'json', 'other fields are untouched');
    });
  });

  describe('query redaction', () => {
    it('redacts sensitive params and keeps the rest', () => {
      assert.equal(redactQuery('q=lamp&sort=price'), 'q=REDACTED&sort=price');
      assert.equal(redactQuery('token=abc&page=2'), 'token=REDACTED&page=2');
      assert.equal(redactQuery('sort=price&page=2'), 'sort=price&page=2', 'untouched without sensitive params');
      assert.equal(redactQuery(undefined), undefined);
    });

    it('redacts every occurrence of a repeated param', () => {
      assert.equal(redactQuery('q=a&q=b'), 'q=REDACTED');
    });
  });

  describe('error serializer', () => {
    it('keeps simple fields but drops attached objects and row data', () => {
      // Shaped like a pg DatabaseError, which carries its whole Client object
      const err = Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        severity: 'ERROR',
        detail: 'Key (email)=(bob@example.com) already exists.',
        client: { secretKey: 12345, connectionParameters: { user: 'postgres' } },
      });

      const out = serializeError(err);
      assert.equal(out.message, 'duplicate key value violates unique constraint');
      assert.equal(out.code, '23505');
      assert.equal(out.severity, 'ERROR');
      assert.ok(out.stack);
      assert.equal(out.client, undefined);
      assert.equal(out.detail, undefined);
    });

    it('serializes cause chains the same way', () => {
      const inner = Object.assign(new Error('inner'), { code: 'X', client: {} });
      const out = serializeError(new Error('outer', { cause: inner }));
      assert.equal(out.cause.message, 'inner');
      assert.equal(out.cause.code, 'X');
      assert.equal(out.cause.client, undefined);
    });
  });
});
