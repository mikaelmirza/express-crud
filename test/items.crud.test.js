import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, resetStore, createItem } from './helpers.js';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

describe('items CRUD', () => {
  beforeEach(resetStore);

  describe('POST /api/items', () => {
    it('creates an item with id and timestamps', async () => {
      const item = await createItem({ name: 'widget', price: 5 });

      assert.match(item.id, /^[0-9a-f-]{36}$/);
      assert.equal(item.name, 'widget');
      assert.equal(item.price, 5);
      assert.ok(item.createdAt);
      assert.equal(item.createdAt, item.updatedAt);
    });

    it('trims the name and strips unknown keys', async () => {
      const item = await createItem({ name: '  widget  ', isAdmin: true });

      assert.equal(item.name, 'widget');
      assert.equal('isAdmin' in item, false);
    });

    it('ignores client-supplied id and timestamps', async () => {
      const item = await createItem({ name: 'x', id: 'mine', createdAt: '1999-01-01' });

      assert.notEqual(item.id, 'mine');
      assert.notEqual(item.createdAt, '1999-01-01');
    });
  });

  describe('GET /api/items/:id', () => {
    it('returns the item', async () => {
      const { id } = await createItem({ name: 'widget' });
      const res = await api().get(`/api/items/${id}`).expect(200);
      assert.equal(res.body.name, 'widget');
    });

    it('returns 404 for an unknown id', async () => {
      await api().get(`/api/items/${MISSING_ID}`).expect(404);
    });
  });

  describe('PUT /api/items/:id', () => {
    it('merges fields and bumps updatedAt, keeping createdAt', async () => {
      const original = await createItem({ name: 'widget', price: 5 });
      await new Promise((r) => setTimeout(r, 5)); // ensure a later timestamp

      const res = await api().put(`/api/items/${original.id}`).send({ price: 7 }).expect(200);

      assert.equal(res.body.name, 'widget');
      assert.equal(res.body.price, 7);
      assert.equal(res.body.createdAt, original.createdAt);
      assert.ok(res.body.updatedAt > original.updatedAt);
    });

    it('cannot change id or createdAt', async () => {
      const original = await createItem({ name: 'widget' });
      const res = await api()
        .put(`/api/items/${original.id}`)
        .send({ name: 'renamed', id: MISSING_ID, createdAt: '1999-01-01' })
        .expect(200);

      assert.equal(res.body.id, original.id);
      assert.equal(res.body.createdAt, original.createdAt);
    });

    it('returns 404 for an unknown id', async () => {
      await api().put(`/api/items/${MISSING_ID}`).send({ name: 'x' }).expect(404);
    });
  });

  describe('DELETE /api/items/:id', () => {
    it('deletes the item', async () => {
      const { id } = await createItem({ name: 'widget' });

      await api().delete(`/api/items/${id}`).expect(204);
      await api().get(`/api/items/${id}`).expect(404);
    });

    it('returns 404 for an unknown id', async () => {
      await api().delete(`/api/items/${MISSING_ID}`).expect(404);
    });
  });
});
