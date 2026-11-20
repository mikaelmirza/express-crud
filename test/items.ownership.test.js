import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, anon, resetStore, registerUser, createItem, seed, query } from './helpers.js';

describe('item ownership', () => {
  let alice;
  let bob;
  let admin;

  beforeEach(async () => {
    await resetStore();
    alice = await registerUser();
    bob = await registerUser();
    admin = await registerUser({ role: 'admin' });
  });

  it('requires authentication on every item route', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    await anon().get('/api/items').expect(401);
    await anon().get(`/api/items/${id}`).expect(401);
    await anon().post('/api/items').send({ name: 'x' }).expect(401);
    await anon().put(`/api/items/${id}`).send({ name: 'x' }).expect(401);
    await anon().delete(`/api/items/${id}`).expect(401);
  });

  it('checks auth before validation, so anonymous requests learn nothing', async () => {
    const res = await anon().post('/api/items').send({}).expect(401);
    assert.deepEqual(res.body, { error: 'Authentication required' });
  });

  it('sets the owner from the token, ignoring any ownerId in the body', async () => {
    const item = await createItem({ name: 'mine', ownerId: bob.user.id }, alice.token);
    assert.equal(item.ownerId, alice.user.id);
  });

  describe("another user's item looks like it doesn't exist", () => {
    let item;
    beforeEach(async () => {
      item = await createItem({ name: 'alice-only', price: 5 }, alice.token);
    });

    it('GET returns 404', async () => {
      await api(bob.token).get(`/api/items/${item.id}`).expect(404);
    });

    it('PUT returns 404 and changes nothing', async () => {
      await api(bob.token).put(`/api/items/${item.id}`).send({ price: 0 }).expect(404);
      const res = await api(alice.token).get(`/api/items/${item.id}`).expect(200);
      assert.equal(res.body.price, 5);
    });

    it('DELETE returns 404 and deletes nothing', async () => {
      await api(bob.token).delete(`/api/items/${item.id}`).expect(404);
      await api(alice.token).get(`/api/items/${item.id}`).expect(200);
    });

    it("gives the same response as an id that doesn't exist", async () => {
      const theirs = await api(bob.token).get(`/api/items/${item.id}`);
      const missing = await api(bob.token).get('/api/items/00000000-0000-4000-8000-000000000000');
      assert.equal(theirs.status, missing.status);
      assert.deepEqual(theirs.body, missing.body);
    });
  });

  describe('listing', () => {
    beforeEach(async () => {
      await seed([{ name: 'a1' }, { name: 'a2' }, { name: 'a3' }], alice.token);
      await seed([{ name: 'b1' }], bob.token);
    });

    it('shows each user only their own items, with matching totals', async () => {
      const a = (await api(alice.token).get('/api/items').expect(200)).body;
      const b = (await api(bob.token).get('/api/items').expect(200)).body;

      assert.deepEqual(a.data.map((i) => i.name), ['a1', 'a2', 'a3']);
      assert.equal(a.meta.total, 3);
      assert.deepEqual(b.data.map((i) => i.name), ['b1']);
      assert.equal(b.meta.total, 1);
    });

    it('scopes pagination and sorting to the user', async () => {
      const res = await api(alice.token).get('/api/items?sort=name&order=desc&limit=2&page=2').expect(200);
      assert.deepEqual(res.body.data.map((i) => i.name), ['a1']);
      assert.equal(res.body.meta.totalPages, 2);
    });

    it('shows a new user an empty list', async () => {
      const carol = await registerUser();
      const res = await api(carol.token).get('/api/items').expect(200);
      assert.deepEqual(res.body.data, []);
      assert.equal(res.body.meta.total, 0);
    });
  });

  describe('admins', () => {
    let item;
    beforeEach(async () => {
      item = await createItem({ name: 'alice-item', price: 5 }, alice.token);
      await createItem({ name: 'bob-item' }, bob.token);
    });

    it('see every item', async () => {
      const res = await api(admin.token).get('/api/items').expect(200);
      assert.deepEqual(res.body.data.map((i) => i.name), ['alice-item', 'bob-item']);
      assert.equal(res.body.meta.total, 2);
    });

    it("can read, update and delete other users' items", async () => {
      await api(admin.token).get(`/api/items/${item.id}`).expect(200);

      const updated = await api(admin.token).put(`/api/items/${item.id}`).send({ price: 9 }).expect(200);
      assert.equal(updated.body.price, 9);
      assert.equal(updated.body.ownerId, alice.user.id, 'owner is unchanged');

      await api(admin.token).delete(`/api/items/${item.id}`).expect(204);
      await api(alice.token).get(`/api/items/${item.id}`).expect(404);
    });

    it('lose admin access as soon as their role changes (no waiting for token expiry)', async () => {
      await query(`UPDATE users SET role = 'user' WHERE id = $1`, [admin.user.id]);
      await api(admin.token).get(`/api/items/${item.id}`).expect(404);
    });
  });

  it("deletes a user's items when the user is deleted", async () => {
    await seed([{ name: 'x' }, { name: 'y' }], alice.token);
    await createItem({ name: 'z' }, bob.token);

    await query('DELETE FROM users WHERE id = $1', [alice.user.id]);

    const { rows } = await query('SELECT count(*)::int AS n FROM items');
    assert.equal(rows[0].n, 1);
  });
});
