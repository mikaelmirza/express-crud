// Starts the real server (src/server.js) as a separate process and sends it
// signals, to test graceful shutdown and crash handling end to end.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const running = new Set();

// Starts the server on a free port. SCRYPT_N is raised so a login takes a
// noticeable time (~0.1s), giving tests a request that's "in flight".
const startServer = async (env = {}, nodeArgs = []) => {
  const child = spawn(process.execPath, ['--env-file=.env.test', ...nodeArgs, 'src/server.js'], {
    env: { ...process.env, PORT: '0', LOG_LEVEL: 'info', SCRYPT_N: String(2 ** 16), ...env },
  });
  running.add(child);
  const lines = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop();
    for (const p of parts) if (p.startsWith('{')) lines.push(JSON.parse(p));
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => { running.delete(child); resolve({ code, signal }); }));

  for (let i = 0; i < 200; i++) {
    const started = lines.find((l) => l['event.name'] === 'server.started');
    if (started) return { child, lines, exited, port: started['server.port'], stderr: () => stderr };
    if (child.exitCode !== null) break;
    await sleep(25);
  }
  throw new Error(`server did not start: ${stderr}`);
};

const agent = new http.Agent({ keepAlive: true });
const send = (port, method, path, body) =>
  new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, agent, headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, body: data }));
    });
    req.on('error', (err) => resolve({ error: err.code }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

const events = (lines) => lines.map((l) => l['event.name']).filter((e) => e?.startsWith('server.') || e?.startsWith('process.'));

afterEach(() => {
  for (const child of running) child.kill('SIGKILL');
});

describe('graceful shutdown', { timeout: 30_000 }, () => {
  it('finishes in-flight requests, then exits 0 promptly', async () => {
    const server = await startServer();
    const email = `drain${Date.now()}@example.com`;
    await send(server.port, 'POST', '/api/auth/register', { email, password: 'correct-horse-battery' });

    const login = send(server.port, 'POST', '/api/auth/login', { email, password: 'correct-horse-battery' });
    await sleep(20);
    const signalled = performance.now();
    server.child.kill('SIGTERM');

    const res = await login;
    assert.equal(res.status, 200, 'the in-flight request completed');
    assert.equal(res.connection, 'close', 'and told the client not to reuse the connection');

    const { code } = await server.exited;
    assert.equal(code, 0);
    assert.ok(performance.now() - signalled < 5000, 'did not wait for the shutdown timeout');
    assert.deepEqual(events(server.lines), ['server.started', 'server.shutdown_started', 'server.stopped']);
    assert.equal(server.lines.find((l) => l['event.name'] === 'server.shutdown_started')['app.requests_in_flight'], 1);
  });

  it('stops accepting connections once draining starts', async () => {
    const server = await startServer();
    server.child.kill('SIGTERM');
    await server.exited;
    const res = await send(server.port, 'GET', '/health/live');
    assert.equal(res.error, 'ECONNREFUSED');
  });

  it('keeps serving with readiness failing during SHUTDOWN_DELAY_MS', async () => {
    const server = await startServer({ SHUTDOWN_DELAY_MS: '1000' });
    server.child.kill('SIGTERM');
    await sleep(200);

    const ready = await send(server.port, 'GET', '/health/ready');
    assert.equal(ready.status, 503);
    assert.deepEqual(JSON.parse(ready.body), { status: 'shutting_down' });
    assert.equal(ready.connection, 'close');

    const live = await send(server.port, 'GET', '/health/live');
    assert.equal(live.status, 200, 'other requests are still served');

    const { code } = await server.exited;
    assert.equal(code, 0);
  });

  it('closes connections still busy after SHUTDOWN_TIMEOUT_MS', async () => {
    const server = await startServer({ SHUTDOWN_TIMEOUT_MS: '100', SCRYPT_N: String(2 ** 17) });
    const email = `slow${Date.now()}@example.com`;
    await send(server.port, 'POST', '/api/auth/register', { email, password: 'correct-horse-battery' });

    const logins = Array.from({ length: 8 }, () => send(server.port, 'POST', '/api/auth/login', { email, password: 'correct-horse-battery' }));
    await sleep(30);
    server.child.kill('SIGTERM');

    const results = await Promise.all(logins);
    assert.ok(results.some((r) => r.error), 'some requests were cut off');
    const { code } = await server.exited;
    assert.equal(code, 0);
    assert.ok(events(server.lines).includes('server.shutdown_timeout'));
  });

  it('exits immediately with code 1 on a second signal', async () => {
    const server = await startServer({ SHUTDOWN_DELAY_MS: '5000' });
    server.child.kill('SIGTERM');
    await sleep(100);
    server.child.kill('SIGTERM');
    const { code } = await server.exited;
    assert.equal(code, 1);
    assert.ok(events(server.lines).includes('server.shutdown_forced'));
  });

  it('handles SIGINT (Ctrl+C) the same way', async () => {
    const server = await startServer();
    server.child.kill('SIGINT');
    const { code } = await server.exited;
    assert.equal(code, 0);
    assert.equal(server.lines.find((l) => l['event.name'] === 'server.shutdown_started').signal, 'SIGINT');
  });
});

describe('crashes', { timeout: 30_000 }, () => {
  it('logs an uncaught exception at fatal, with its stack, and exits 1', async () => {
    const crash = 'data:text/javascript,setTimeout(() => { throw new Error("simulated crash") }, 2000)';
    const server = await startServer({}, ['--import', crash]);
    const { code } = await server.exited;

    assert.equal(code, 1);
    const fatal = server.lines.find((l) => l.level === 'fatal');
    assert.equal(fatal['event.name'], 'process.crashed');
    assert.equal(fatal['error.type'], 'uncaught exception');
    assert.equal(fatal.err.message, 'simulated crash');
    assert.match(fatal.err.stack, /at /);
  });

  it('treats an unhandled promise rejection the same way', async () => {
    const crash = 'data:text/javascript,setTimeout(() => { Promise.reject(new Error("forgot to await")) }, 2000)';
    const server = await startServer({}, ['--import', crash]);
    const { code } = await server.exited;

    assert.equal(code, 1);
    const fatal = server.lines.find((l) => l.level === 'fatal');
    assert.equal(fatal['error.type'], 'unhandled promise rejection');
    assert.equal(fatal.err.message, 'forgot to await');
  });
});

describe('startup errors', { timeout: 30_000 }, () => {
  const run = (env) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['--env-file=.env.test', 'src/server.js'], { env: { ...process.env, ...env } });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('exit', (code) => resolve({ code, out }));
    });

  it('prints a short list of configuration problems, not a stack trace', async () => {
    const { code, out } = await run({ PORT: 'abc', LOG_LEVEL: 'loud' });
    assert.equal(code, 1);
    assert.match(out, /^Invalid configuration:\n {2}- PORT: .+\n {2}- LOG_LEVEL: /);
    assert.doesNotMatch(out, /at .+\.js:\d+/);
  });

  it('explains how to generate a missing JWT secret', async () => {
    const { code, out } = await run({ JWT_SECRET: 'too-short' });
    assert.equal(code, 1);
    assert.match(out, /JWT_SECRET must be at least 32 characters\. Generate one with: node -e/);
  });

  it('explains a port that is already in use', async () => {
    const blocker = http.createServer().listen(0);
    await new Promise((r) => blocker.once('listening', r));
    const { code, out } = await run({ PORT: String(blocker.address().port) });
    blocker.close();
    assert.equal(code, 1);
    assert.match(out, /^Port \d+ is already in use\./);
  });
});
