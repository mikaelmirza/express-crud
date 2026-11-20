import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { anon, api, resetStore, registerUser, uniqueEmail, query, PASSWORD } from './helpers.js';

const secret = new TextEncoder().encode(process.env.JWT_SECRET);

// Asserts a response never exposes password data
const assertNoPasswordLeak = (res) => {
  const text = JSON.stringify(res.body);
  assert.doesNotMatch(text, /password|scrypt\$/i);
};

describe('auth', () => {
  beforeEach(resetStore);

  describe('POST /api/auth/register', () => {
    it('creates a user and returns a token', async () => {
      const res = await anon()
        .post('/api/auth/register')
        .send({ email: 'new@example.com', password: PASSWORD })
        .expect(201);

      assert.equal(res.body.user.email, 'new@example.com');
      assert.equal(res.body.user.role, 'user');
      assert.ok(res.body.token);
      assertNoPasswordLeak(res);
    });

    it('normalizes the email to trimmed lowercase', async () => {
      const res = await anon()
        .post('/api/auth/register')
        .send({ email: '  Mixed@Example.COM ', password: PASSWORD })
        .expect(201);
      assert.equal(res.body.user.email, 'mixed@example.com');
    });

    it('rejects a duplicate email regardless of case', async () => {
      await registerUser({ email: 'dupe@example.com' });
      const res = await anon()
        .post('/api/auth/register')
        .send({ email: 'DUPE@example.com', password: PASSWORD })
        .expect(409);
      assert.equal(res.body.error, 'Email is already registered');
    });

    it('cannot self-register as admin', async () => {
      const res = await anon()
        .post('/api/auth/register')
        .send({ email: uniqueEmail(), password: PASSWORD, role: 'admin' })
        .expect(201);
      assert.equal(res.body.user.role, 'user');
    });

    it('stores a scrypt hash, not the password', async () => {
      const { user } = await registerUser();
      const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
      assert.match(rows[0].password_hash, /^scrypt\$\d+\$8\$1\$/);
      assert.ok(!rows[0].password_hash.includes(PASSWORD));
    });

    for (const [label, body] of [
      ['an invalid email', { email: 'not-an-email', password: PASSWORD }],
      ['a short password', { email: uniqueEmail(), password: 'short' }],
      ['an overlong password', { email: uniqueEmail(), password: 'x'.repeat(129) }],
    ]) {
      it(`rejects ${label}`, async () => {
        await anon().post('/api/auth/register').send(body).expect(400);
      });
    }
  });

  describe('POST /api/auth/login', () => {
    it('returns a token for valid credentials, with any email case', async () => {
      await registerUser({ email: 'login@example.com' });
      const res = await anon()
        .post('/api/auth/login')
        .send({ email: 'LOGIN@example.com', password: PASSWORD })
        .expect(200);

      assert.equal(res.body.user.email, 'login@example.com');
      assert.ok(res.body.token);
      assertNoPasswordLeak(res);
    });

    it('gives identical responses for a wrong password and an unknown email', async () => {
      await registerUser({ email: 'real@example.com' });

      const wrongPassword = await anon()
        .post('/api/auth/login')
        .send({ email: 'real@example.com', password: 'wrong-password' });
      const unknownEmail = await anon()
        .post('/api/auth/login')
        .send({ email: 'ghost@example.com', password: PASSWORD });

      assert.equal(wrongPassword.status, 401);
      assert.equal(unknownEmail.status, 401);
      assert.deepEqual(wrongPassword.body, unknownEmail.body);
    });

    it('returns a token that works on protected routes', async () => {
      const { user } = await registerUser({ email: 'works@example.com' });
      const { body } = await anon()
        .post('/api/auth/login')
        .send({ email: 'works@example.com', password: PASSWORD });

      const me = await api(body.token).get('/api/auth/me').expect(200);
      assert.equal(me.body.id, user.id);
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns the current user without password data', async () => {
      const { user, token } = await registerUser();
      const res = await api(token).get('/api/auth/me').expect(200);
      assert.deepEqual(res.body, user);
      assertNoPasswordLeak(res);
    });
  });

  describe('rejected tokens', () => {
    const expect401 = async (authorization) => {
      let req = anon().get('/api/auth/me');
      if (authorization) req = req.set('Authorization', authorization);
      const res = await req.expect(401);
      assert.equal(res.headers['www-authenticate'], 'Bearer');
      assert.deepEqual(res.body, { error: 'Authentication required' });
    };

    it('missing header', () => expect401(null));
    it('wrong scheme', () => expect401('Basic dXNlcjpwYXNz'));
    it('empty bearer token', () => expect401('Bearer '));
    it('garbage token', () => expect401('Bearer not.a.jwt'));

    it('tampered payload', async () => {
      const { token } = await registerUser();
      const [header, , signature] = token.split('.');
      const forged = Buffer.from(JSON.stringify({ sub: '00000000-0000-4000-8000-000000000000' })).toString('base64url');
      await expect401(`Bearer ${header}.${forged}.${signature}`);
    });

    it('expired token', async () => {
      const { user } = await registerUser();
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.id)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
        .sign(secret);
      await expect401(`Bearer ${token}`);
    });

    it('signed with a different secret', async () => {
      const { user } = await registerUser();
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.id)
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode('some-other-secret-that-is-32-chars-long!'));
      await expect401(`Bearer ${token}`);
    });

    it('unsigned token (alg: none)', async () => {
      const { user } = await registerUser();
      const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
      const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: user.id })}.`;
      await expect401(`Bearer ${token}`);
    });

    it('valid token for a user who has since been deleted', async () => {
      const { user, token } = await registerUser();
      await query('DELETE FROM users WHERE id = $1', [user.id]);
      await expect401(`Bearer ${token}`);
    });
  });
});
