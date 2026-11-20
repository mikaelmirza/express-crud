import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, resetStore, createItem } from './helpers.js';

// Returns the validation issues from a 400 response
const issues = (res) => {
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  return res.body.details;
};

const paths = (res) => issues(res).map((d) => `${d.location}.${d.path}`).sort();

describe('items validation', () => {
  beforeEach(resetStore);

  describe('body', () => {
    it('requires a name on create', async () => {
      const res = await api().post('/api/items').send({});
      assert.deepEqual(paths(res), ['body.name']);
    });

    it('rejects a blank name (after trimming)', async () => {
      const res = await api().post('/api/items').send({ name: '   ' });
      assert.deepEqual(paths(res), ['body.name']);
    });

    it('rejects wrong types and out-of-range values', async () => {
      const res = await api().post('/api/items').send({ name: 'x', price: '5' });
      assert.deepEqual(paths(res), ['body.price']);

      const res2 = await api().post('/api/items').send({ name: 'x', price: -1 });
      assert.deepEqual(paths(res2), ['body.price']);
    });

    it('reports every problem in one response', async () => {
      const res = await api().post('/api/items').send({ name: '', price: -1 });
      assert.deepEqual(paths(res), ['body.name', 'body.price']);
    });

    it('rejects an empty update', async () => {
      const { id } = await createItem({ name: 'widget' });
      const res = await api().put(`/api/items/${id}`).send({});
      assert.match(issues(res)[0].message, /At least one field/);
    });
  });

  describe('params', () => {
    for (const method of ['get', 'put', 'delete']) {
      it(`${method.toUpperCase()} rejects a non-UUID id`, async () => {
        const res = await api()[method]('/api/items/not-a-uuid').send({ name: 'x' });
        assert.deepEqual(paths(res), ['params.id']);
      });
    }

    it('reports params and body errors together', async () => {
      const res = await api().put('/api/items/not-a-uuid').send({ price: -1 });
      assert.deepEqual(paths(res), ['body.price', 'params.id']);
    });
  });

  describe('query', () => {
    const cases = [
      ['page=0', 'query.page'],
      ['page=abc', 'query.page'],
      ['page=1.5', 'query.page'],
      ['limit=0', 'query.limit'],
      ['limit=101', 'query.limit'],
      ['sort=password', 'query.sort'],
      ['order=sideways', 'query.order'],
    ];

    for (const [qs, path] of cases) {
      it(`rejects ${qs}`, async () => {
        const res = await api().get(`/api/items?${qs}`);
        assert.deepEqual(paths(res), [path]);
      });
    }

    it('accepts limit at the max of 100', async () => {
      await api().get('/api/items?limit=100').expect(200);
    });
  });
});
