import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers.js';

describe('app', () => {
  it('GET /health returns ok', async () => {
    const res = await api().get('/health').expect(200);
    assert.deepEqual(res.body, { status: 'ok' });
  });

  it('unknown routes return 404 JSON', async () => {
    const res = await api().get('/nope').expect(404);
    assert.match(res.body.error, /GET \/nope not found/);
  });

  it('malformed JSON returns a 400, not a 500', async () => {
    await api()
      .post('/api/items')
      .set('content-type', 'application/json')
      .send('{"name":')
      .expect(400);
  });
});
