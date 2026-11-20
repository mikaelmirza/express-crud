import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import request from 'supertest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logging/logger.js';
import { createHttpLogger } from '../src/logging/httpLogger.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { spanExporter, logExporter } from './support/instrumentation.js';
import { api, anon, resetStore, registerUser, createItem, query, PASSWORD } from './helpers.js';

const spans = () => spanExporter.getFinishedSpans();
const traceIdOf = (span) => span.spanContext().traceId;
const parentIdOf = (span) => span.parentSpanContext?.spanId;

// Spans end when the response finishes, which can be just after the client has
// the response. Wait briefly for the request's server span to be exported.
const serverSpanFor = async (res, timeoutMs = 1000) => {
  const id = res.headers['x-request-id'];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const span = spans().find((s) => s.kind === SpanKind.SERVER && s.attributes['app.request_id'] === id);
    if (span) {
      await sleep(10); // let any remaining child spans finish exporting
      return span;
    }
    await sleep(5);
  }
  assert.fail(`no server span for request ${id}`);
};

const spansInTrace = (span) => spans().filter((s) => traceIdOf(s) === traceIdOf(span));
const descendantsOf = (root) => {
  const all = spansInTrace(root);
  const result = [];
  const walk = (id) =>
    all.filter((s) => parentIdOf(s) === id).forEach((child) => {
      result.push(child);
      walk(child.spanContext().spanId);
    });
  walk(root.spanContext().spanId);
  return result;
};

// Everything recorded in a span or log record, as one string, for leak checks
const recordedText = () =>
  JSON.stringify([
    ...spans().map((s) => [s.name, s.attributes, s.events.map((e) => [e.name, e.attributes]), s.status]),
    ...logExporter.getFinishedLogRecords().map((r) => [r.body, r.attributes]),
  ]);

describe('tracing', () => {
  beforeEach(async () => {
    await resetStore();
    spanExporter.reset();
    logExporter.reset();
  });

  describe('request traces', () => {
    it('creates a server span with route, status, user and request id', async () => {
      const { user, token } = await registerUser();
      const res = await api(token).get('/api/items?sort=price').expect(200);
      const server = await serverSpanFor(res);

      assert.equal(server.name, 'GET /api/items');
      assert.equal(server.attributes['http.route'], '/api/items');
      assert.equal(server.attributes['http.response.status_code'], 200);
      assert.equal(server.attributes['user.id'], user.id);
      assert.deepEqual(server.attributes['user.roles'], ['user']);
      assert.equal(server.status.code, SpanStatusCode.UNSET);
    });

    it("continues the caller's trace (here, the test's own HTTP client)", async () => {
      // supertest makes a real HTTP request, which the http instrumentation
      // traces as a client span and propagates with a traceparent header
      const res = await anon().get('/nope');
      const server = await serverSpanFor(res);
      const client = spans().find((s) => s.spanContext().spanId === parentIdOf(server));

      assert.ok(client, 'the parent span was recorded');
      assert.equal(client.kind, SpanKind.CLIENT);
      assert.equal(traceIdOf(client), traceIdOf(server));
    });

    it('nests middleware, handler and SQL spans under the request', async () => {
      const { token } = await registerUser();
      const res = await api(token).get('/api/items').expect(200);
      const names = descendantsOf(await serverSpanFor(res)).map((s) => s.name);

      assert.ok(names.includes('middleware - authenticate'), names.join(', '));
      assert.ok(names.includes('request handler - /api/items'), names.join(', '));
      assert.ok(names.filter((n) => n.startsWith('pg.query')).length >= 3, 'user lookup + list + count');
    });

    it('leaves out noisy Express internals and router layers', async () => {
      const { token } = await registerUser();
      const res = await api(token).get('/api/items').expect(200);
      const names = descendantsOf(await serverSpanFor(res)).map((s) => s.name);

      for (const noisy of ['query', 'expressInit', 'jsonParser', 'requestLogger']) {
        assert.ok(!names.includes(`middleware - ${noisy}`), `unexpected span middleware - ${noisy}`);
      }
      assert.ok(!names.some((n) => n.startsWith('router - ')), names.join(', '));
    });

    it('records SQL text with placeholders, never parameter values', async () => {
      const { user, token } = await registerUser();
      await createItem({ name: 'desk lamp', price: 25 }, token);
      const res = await api(token).get('/api/items?minPrice=10').expect(200);

      const queries = descendantsOf(await serverSpanFor(res)).filter((s) => s.name.startsWith('pg.query'));
      const list = queries.find((s) => /FROM items\s+WHERE/.test(s.attributes['db.query.text']));
      assert.ok(list, 'the list query has a span');
      assert.match(list.attributes['db.query.text'], /owner_id = \$1/);

      for (const span of queries) {
        assert.ok(!Object.keys(span.attributes).some((k) => k.includes('parameter') || k.includes('values')));
        assert.ok(!JSON.stringify(span.attributes).includes(user.id), 'no parameter values');
      }
    });

    it('describes searches on the request span, without the search text', async () => {
      const { token } = await registerUser();
      const res = await api(token).get('/api/items?q=la&minPrice=1&sort=price&order=desc').expect(200);
      const server = await serverSpanFor(res);

      assert.equal(server.attributes['app.search.query_length'], 2);
      assert.deepEqual(server.attributes['app.list.filters'], ['q', 'minPrice']);
      assert.equal(server.attributes['app.list.sort'], 'price desc');
      assert.equal(server.attributes['app.list.total'], 0);
      assert.equal(server.attributes['url.query'], 'q=REDACTED&minPrice=1&sort=price&order=desc');
    });

    it('does not trace /health', async () => {
      await anon().get('/health').expect(200);
      await sleep(50);
      assert.equal(spans().filter((s) => s.kind === SpanKind.SERVER).length, 0);
    });
  });

  describe('password hashing spans', () => {
    it('shows scrypt work on register', async () => {
      const res = await anon().post('/api/auth/register').send({ email: 'hash@example.com', password: PASSWORD }).expect(201);
      const hash = descendantsOf(await serverSpanFor(res)).find((s) => s.name === 'auth.hash_password');

      assert.ok(hash, 'auth.hash_password span');
      assert.equal(hash.attributes['auth.scrypt.cost'], Number(process.env.SCRYPT_N));
    });

    it('shows scrypt work on login, for known and unknown emails alike', async () => {
      await registerUser({ email: 'verify@example.com' });

      for (const email of ['verify@example.com', 'ghost@example.com']) {
        spanExporter.reset();
        const res = await anon().post('/api/auth/login').send({ email, password: 'wrong-password' }).expect(401);
        const names = descendantsOf(await serverSpanFor(res)).map((s) => s.name);
        assert.ok(names.includes('auth.verify_password'), `${email}: ${names.join(', ')}`);
      }
    });
  });

  describe('errors', () => {
    const failingApp = () => {
      const a = express();
      a.use(createHttpLogger(createLogger({ level: 'silent' })));
      a.get('/boom', () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      });
      a.use(errorHandler);
      return a;
    };

    it('marks 5xx request spans as errors with the exception attached', async () => {
      const res = await request(failingApp()).get('/boom').expect(500);
      const server = await serverSpanFor(res);

      assert.equal(server.status.code, SpanStatusCode.ERROR);
      const exception = server.events.find((e) => e.name === 'exception');
      assert.ok(exception, 'exception event on the request span');
      assert.equal(exception.attributes['exception.message'], 'connect ECONNREFUSED 127.0.0.1:5432');
      assert.match(exception.attributes['exception.stacktrace'], /at /);
    });

    it('does not mark 4xx request spans as errors', async () => {
      const { token } = await registerUser();
      for (const req of [anon().get('/nope'), api(token).get('/api/items?limit=0'), anon().get('/api/items')]) {
        const res = await req;
        assert.ok(res.status >= 400 && res.status < 500);
        const server = await serverSpanFor(res);
        assert.notEqual(server.status.code, SpanStatusCode.ERROR, `${res.status} marked as error`);
      }
    });
  });

  describe('context propagation', () => {
    it('continues an incoming W3C traceparent', async () => {
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const parentId = '00f067aa0ba902b7';
      const res = await anon().get('/nope').set('traceparent', `00-${traceId}-${parentId}-01`);
      const server = await serverSpanFor(res);

      assert.equal(traceIdOf(server), traceId);
      assert.equal(parentIdOf(server), parentId);
    });

    it('starts a new trace for a malformed traceparent', async () => {
      // .set() replaces the traceparent the test's own client span injected
      const res = await anon().get('/nope').set('traceparent', 'not-a-traceparent');
      const server = await serverSpanFor(res);
      assert.match(traceIdOf(server), /^[0-9a-f]{32}$/);
      assert.equal(server.parentSpanContext, undefined);
    });
  });

  describe('logs', () => {
    // An app whose logger writes to memory, so we can read the JSON lines
    const captureApp = () => {
      const lines = [];
      const logger = createLogger({ level: 'info', destination: { write: (l) => lines.push(JSON.parse(l)) } });
      return { app: createApp({ logger }), lines };
    };

    it("adds the request's trace_id and a span_id to its log lines", async () => {
      const { app, lines } = captureApp();
      const res = await request(app).post('/api/auth/register').send({ email: 'logs@example.com', password: PASSWORD });
      const server = await serverSpanFor(res);

      const forRequest = lines.filter((l) => l.request_id === res.headers['x-request-id']);
      assert.equal(forRequest.length, 2, 'user.registered event + request line');
      const ids = new Set(spansInTrace(server).map((s) => s.spanContext().spanId));
      for (const line of forRequest) {
        assert.equal(line.trace_id, traceIdOf(server), line.msg);
        assert.ok(ids.has(line.span_id), `${line.msg}: span_id belongs to the trace`);
      }
    });

    it('exports log records linked to the trace', async () => {
      const { app } = captureApp();
      const res = await request(app).get('/nope').expect(404);
      const server = await serverSpanFor(res);

      const record = logExporter.getFinishedLogRecords().find((r) => r.body === 'GET /nope 404');
      assert.ok(record, 'request line exported as a log record');
      assert.equal(record.spanContext.traceId, traceIdOf(server));
      assert.equal(record.severityText, 'warn');
    });
  });

  describe('privacy', () => {
    it('never records passwords, hashes, tokens, emails or search text', async () => {
      const email = 'private@example.com';
      const reg = await anon().post('/api/auth/register').send({ email, password: PASSWORD }).expect(201);
      const { token } = reg.body;
      await anon().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
      await anon().post('/api/auth/login').send({ email, password: 'wrong-password' }).expect(401);
      await api(token).get('/api/items?q=my-secret-search').expect(200);
      const last = await api(token).get('/api/auth/me').expect(200);
      await serverSpanFor(last);

      const { rows } = await query('SELECT password_hash FROM users WHERE email = $1', [email]);
      const text = recordedText();
      assert.ok(spans().length > 10, 'sanity check: spans were recorded');
      for (const secret of [PASSWORD, 'wrong-password', email, token, rows[0].password_hash, 'Bearer', 'my-secret-search']) {
        assert.ok(!text.includes(secret), `telemetry contains ${secret.slice(0, 20)}`);
      }
    });
  });
});
