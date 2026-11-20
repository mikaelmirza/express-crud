import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, resetStore, registerUser, seed, createItem, query } from './helpers.js';

const list = async (qs = '', token) => (await api(token).get(`/api/items${qs}`).expect(200)).body;
const names = (body) => body.data.map((i) => i.name);

// Validation issue paths from a 400 response
const errorPaths = async (qs) => {
  const res = await api().get(`/api/items${qs}`).expect(400);
  return res.body.details.map((d) => d.path).sort();
};

// created_at is server-set, so tests pin it directly in the database
const setCreatedAt = (id, timestamp) =>
  query('UPDATE items SET created_at = $2 WHERE id = $1', [id, timestamp]);

describe('GET /api/items filtering and search', () => {
  beforeEach(resetStore);

  describe('q (search)', () => {
    beforeEach(() =>
      seed([
        { name: 'Desk Lamp', description: 'Warm white light' },
        { name: 'Floor lamp', price: 40 },
        { name: 'Bookshelf', description: 'Fits a LAMP on top' },
        { name: 'Chair' },
        { name: '50% off sale' },
        { name: '500 off' },
        { name: 'snake_case' },
        { name: 'snakeXcase' },
      ])
    );

    it('matches name or description, case-insensitively', async () => {
      assert.deepEqual(names(await list('?q=lamp')), ['Desk Lamp', 'Floor lamp', 'Bookshelf']);
    });

    it('matches partial words', async () => {
      assert.deepEqual(names(await list('?q=ook')), ['Bookshelf']);
    });

    it('treats % as a literal character, not a wildcard', async () => {
      assert.deepEqual(names(await list('?q=50%25')), ['50% off sale']);
    });

    it('treats _ as a literal character, not a wildcard', async () => {
      assert.deepEqual(names(await list('?q=snake_')), ['snake_case']);
    });

    it('trims whitespace around the search text', async () => {
      assert.deepEqual(names(await list('?q=%20%20chair%20')), ['Chair']);
    });

    it('treats an empty q as no search', async () => {
      assert.equal((await list('?q=')).meta.total, 8);
      assert.equal((await list('?q=%20%20')).meta.total, 8);
    });

    it('returns an empty list when nothing matches', async () => {
      const body = await list('?q=sofa');
      assert.deepEqual(body.data, []);
      assert.equal(body.meta.total, 0);
    });
  });

  describe('price filters', () => {
    beforeEach(() =>
      seed([
        { name: 'free', price: 0 },
        { name: 'cheap', price: 5 },
        { name: 'mid', price: 10 },
        { name: 'pricey', price: 50 },
        { name: 'unpriced' },
      ])
    );

    it('minPrice is inclusive', async () => {
      assert.deepEqual(names(await list('?minPrice=10')), ['mid', 'pricey']);
    });

    it('maxPrice is inclusive', async () => {
      assert.deepEqual(names(await list('?maxPrice=5')), ['free', 'cheap']);
    });

    it('combines into a range', async () => {
      assert.deepEqual(names(await list('?minPrice=5&maxPrice=10')), ['cheap', 'mid']);
    });

    it('allows minPrice equal to maxPrice', async () => {
      assert.deepEqual(names(await list('?minPrice=10&maxPrice=10')), ['mid']);
    });

    it('excludes unpriced items from ranges, even minPrice=0', async () => {
      assert.ok(!names(await list('?minPrice=0')).includes('unpriced'));
    });

    it('accepts decimals', async () => {
      assert.deepEqual(names(await list('?minPrice=4.99&maxPrice=5.01')), ['cheap']);
    });

    it('hasPrice=false finds unpriced items', async () => {
      assert.deepEqual(names(await list('?hasPrice=false')), ['unpriced']);
    });

    it('hasPrice=true finds priced items, including a price of 0', async () => {
      assert.deepEqual(names(await list('?hasPrice=true')), ['free', 'cheap', 'mid', 'pricey']);
    });

    it('treats an empty minPrice as not given (not as 0)', async () => {
      assert.equal((await list('?minPrice=')).meta.total, 5);
    });
  });

  describe('date filters', () => {
    beforeEach(async () => {
      const [oct, novStart, nov] = await seed([{ name: 'october' }, { name: 'nov-start' }, { name: 'november' }]);
      await setCreatedAt(oct.id, '2026-10-15T12:00:00Z');
      await setCreatedAt(novStart.id, '2026-11-01T00:00:00Z');
      await setCreatedAt(nov.id, '2026-11-20T12:00:00Z');
    });

    it('createdAfter is inclusive', async () => {
      assert.deepEqual(names(await list('?createdAfter=2026-11-01')), ['nov-start', 'november']);
    });

    it('createdBefore is exclusive', async () => {
      assert.deepEqual(names(await list('?createdBefore=2026-11-01')), ['october']);
    });

    it('back-to-back ranges count every item exactly once', async () => {
      const october = names(await list('?createdAfter=2026-10-01&createdBefore=2026-11-01'));
      const november = names(await list('?createdAfter=2026-11-01&createdBefore=2026-12-01'));
      assert.deepEqual(october, ['october']);
      assert.deepEqual(november, ['nov-start', 'november']);
    });

    it('accepts full timestamps with a timezone offset', async () => {
      // 2026-11-01T02:00:00+02:00 is 2026-11-01T00:00:00Z, exactly nov-start
      const body = await list(`?createdAfter=${encodeURIComponent('2026-11-01T02:00:00+02:00')}`);
      assert.deepEqual(names(body), ['nov-start', 'november']);
    });
  });

  describe('combined with sorting and paging', () => {
    beforeEach(() =>
      seed([
        { name: 'lamp a', price: 30 },
        { name: 'lamp b', price: 10 },
        { name: 'lamp c', price: 20 },
        { name: 'lamp d' },
        { name: 'chair', price: 15 },
      ])
    );

    it('combines filters with AND', async () => {
      assert.deepEqual(names(await list('?q=lamp&minPrice=15')), ['lamp a', 'lamp c']);
    });

    it('sorts and pages within the filtered results, with totals to match', async () => {
      const page1 = await list('?q=lamp&hasPrice=true&sort=price&order=desc&limit=2');
      const page2 = await list('?q=lamp&hasPrice=true&sort=price&order=desc&limit=2&page=2');

      assert.deepEqual(names(page1), ['lamp a', 'lamp c']);
      assert.deepEqual(names(page2), ['lamp b']);
      assert.equal(page1.meta.total, 3);
      assert.equal(page1.meta.totalPages, 2);
    });

    it('echoes the applied filters in meta, normalized', async () => {
      const body = await list('?q=%20lamp%20&minPrice=15&hasPrice=true&createdAfter=2026-01-01&maxPrice=');
      assert.deepEqual(body.meta.filters, {
        q: 'lamp',
        minPrice: 15,
        hasPrice: true,
        createdAfter: '2026-01-01T00:00:00Z',
      });
    });

    it('ignores unknown query params', async () => {
      const body = await list('?q=chair&color=red');
      assert.deepEqual(names(body), ['chair']);
      assert.deepEqual(body.meta.filters, { q: 'chair' });
    });
  });

  describe('ownership', () => {
    let alice;
    let bob;
    let admin;

    beforeEach(async () => {
      alice = await registerUser();
      bob = await registerUser();
      admin = await registerUser({ role: 'admin' });
      await createItem({ name: 'alice secret lamp', price: 5 }, alice.token);
      await createItem({ name: 'bob lamp', price: 5 }, bob.token);
    });

    it("can't find another user's items by searching", async () => {
      assert.deepEqual(names(await list('?q=secret', bob.token)), []);
      assert.deepEqual(names(await list('?q=lamp', bob.token)), ['bob lamp']);
    });

    it("price filters don't reveal other users' items", async () => {
      assert.deepEqual(names(await list('?minPrice=0', bob.token)), ['bob lamp']);
    });

    it('lets admins filter by owner', async () => {
      assert.deepEqual(names(await list(`?ownerId=${alice.user.id}`, admin.token)), ['alice secret lamp']);
    });

    it('lets admins search across all users', async () => {
      assert.deepEqual(names(await list('?q=lamp', admin.token)), ['alice secret lamp', 'bob lamp']);
    });

    it("returns an empty list when a non-admin filters by someone else's id", async () => {
      const body = await list(`?ownerId=${alice.user.id}`, bob.token);
      assert.deepEqual(body.data, []);
      assert.equal(body.meta.total, 0);
    });

    it('lets a non-admin filter by their own id', async () => {
      assert.deepEqual(names(await list(`?ownerId=${bob.user.id}`, bob.token)), ['bob lamp']);
    });
  });

  describe('validation', () => {
    const cases = [
      ['?minPrice=-1', ['minPrice']],
      ['?maxPrice=abc', ['maxPrice']],
      ['?minPrice=10&maxPrice=5', ['minPrice']],
      ['?hasPrice=yes', ['hasPrice']],
      ['?hasPrice=1', ['hasPrice']],
      ['?createdAfter=yesterday', ['createdAfter']],
      ['?createdAfter=1', ['createdAfter']],
      ['?createdAfter=2026-11-05T10:00:00', ['createdAfter']], // no timezone
      ['?createdAfter=2026-11-02&createdBefore=2026-11-01', ['createdAfter']],
      ['?createdAfter=2026-11-01&createdBefore=2026-11-01', ['createdAfter']], // empty range
      [`?q=${'x'.repeat(101)}`, ['q']],
      ['?q=a&q=b', ['q']],
      ['?ownerId=not-a-uuid', ['ownerId']],
    ];

    for (const [qs, paths] of cases) {
      it(`rejects ${qs.length > 50 ? qs.slice(0, 50) + '…' : qs}`, async () => {
        assert.deepEqual(await errorPaths(qs), paths);
      });
    }

    it('explains the expected date format', async () => {
      const res = await api().get('/api/items?createdAfter=yesterday').expect(400);
      assert.match(res.body.details[0].message, /YYYY-MM-DD/);
    });
  });
});
