import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { errorHandler } from '../src/middleware/errorHandler.js';

// Minimal Express-like response that records what was sent
const fakeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (body) => ((res.body = body), res);
  return res;
};

describe('errorHandler', () => {
  it('hides internal details on 500, returns the request id, and hands the error to the request logger', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const res = fakeRes();

    errorHandler(err, { id: 'req-123' }, res, () => {});

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Internal Server Error', requestId: 'req-123' });
    assert.equal(res.err, err);
  });

  it('passes client error messages through without attaching the error', () => {
    const err = Object.assign(new Error('Unexpected end of JSON input'), { status: 400 });
    const res = fakeRes();

    errorHandler(err, { id: 'req-123' }, res, () => {});

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'Unexpected end of JSON input' });
    assert.equal(res.err, undefined);
  });
});
