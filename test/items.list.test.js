import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, resetStore, seed } from './helpers.js';

const list = async (qs = '') => (await api().get(`/api/items${qs}`).expect(200)).body;
const names = (body) => body.data.map((i) => i.name);

describe('GET /api/items', () => {
  beforeEach(resetStore);

  describe('pagination', () => {
    beforeEach(() => seed(Array.from({ length: 12 }, (_, i) => ({ name: `item${i + 1}` }))));

    it('applies defaults when no params are given', async () => {
      const body = await list();
      assert.equal(body.data.length, 12);
      assert.deepEqual(body.meta, {
        page: 1, limit: 20, total: 12, totalPages: 1, sort: 'createdAt', order: 'asc', filters: {},
      });
    });

    it('returns the requested page', async () => {
      const body = await list('?page=2&limit=5');
      assert.deepEqual(names(body), ['item6', 'item7', 'item8', 'item9', 'item10']);
      assert.equal(body.meta.totalPages, 3);
    });

    it('returns a partial last page', async () => {
      const body = await list('?page=3&limit=5');
      assert.deepEqual(names(body), ['item11', 'item12']);
    });

    it('returns empty data past the last page, with correct meta', async () => {
      const body = await list('?page=9&limit=5');
      assert.deepEqual(body.data, []);
      assert.equal(body.meta.total, 12);
      assert.equal(body.meta.totalPages, 3);
    });

    it('pages cover every item exactly once', async () => {
      const seen = [];
      for (let page = 1; page <= 3; page++) seen.push(...names(await list(`?page=${page}&limit=5`)));
      assert.equal(seen.length, 12);
      assert.equal(new Set(seen).size, 12);
    });
  });

  it('returns empty data with totalPages 0 when there are no items', async () => {
    const body = await list();
    assert.deepEqual(body.data, []);
    assert.equal(body.meta.total, 0);
    assert.equal(body.meta.totalPages, 0);
  });

  describe('sorting', () => {
    beforeEach(() =>
      seed([
        { name: 'cherry', price: 3 },
        { name: 'Banana', price: 1 },
        { name: 'apple' },
        { name: 'date', price: 5 },
        { name: 'elder', price: 3 },
        { name: 'fig' },
      ])
    );

    it('defaults to creation order', async () => {
      assert.deepEqual(names(await list()), ['cherry', 'Banana', 'apple', 'date', 'elder', 'fig']);
    });

    it('sorts names case-insensitively, ascending', async () => {
      assert.deepEqual(names(await list('?sort=name')), ['apple', 'Banana', 'cherry', 'date', 'elder', 'fig']);
    });

    it('sorts names descending', async () => {
      assert.deepEqual(
        names(await list('?sort=name&order=desc')),
        ['fig', 'elder', 'date', 'cherry', 'Banana', 'apple']
      );
    });

    it('puts items missing the field last when ascending', async () => {
      assert.deepEqual(
        names(await list('?sort=price')),
        ['Banana', 'cherry', 'elder', 'date', 'apple', 'fig']
      );
    });

    it('puts items missing the field last when descending too', async () => {
      assert.deepEqual(
        names(await list('?sort=price&order=desc')),
        ['date', 'cherry', 'elder', 'Banana', 'apple', 'fig']
      );
    });

    it('keeps creation order for ties (cherry before elder at $3)', async () => {
      for (const order of ['asc', 'desc']) {
        const result = names(await list(`?sort=price&order=${order}`));
        assert.ok(result.indexOf('cherry') < result.indexOf('elder'), order);
      }
    });

    it('sorts before paginating', async () => {
      const page1 = await list('?sort=price&order=desc&limit=3');
      const page2 = await list('?sort=price&order=desc&limit=3&page=2');

      assert.deepEqual(names(page1), ['date', 'cherry', 'elder']);
      assert.deepEqual(names(page2), ['Banana', 'apple', 'fig']);
      assert.equal(page1.meta.sort, 'price');
      assert.equal(page1.meta.order, 'desc');
    });
  });
});
