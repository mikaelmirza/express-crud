import { after } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { clear } from '../src/services/item.service.js';
import { setRole } from '../src/services/user.service.js';
import { closePool, query } from '../src/db/pool.js';

// Close the pool after each test file, or open connections keep the process alive
after(closePool);

export { query };

export const PASSWORD = 'correct-horse-battery';

let emailCounter = 0;
export const uniqueEmail = () => `user${++emailCounter}@example.com`;

// Token for a default user, registered fresh after every reset. Tests that
// don't care about auth use it implicitly through api().
let defaultToken = null;

// Request builder that sends `Authorization: Bearer <token>` when a token is set.
// api() uses the default user; api(token) acts as someone else; anon() sends none.
export const api = (token = defaultToken) => {
  const agent = request(app);
  const withAuth = (method) => (url) => {
    const req = agent[method](url);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  return {
    get: withAuth('get'),
    post: withAuth('post'),
    put: withAuth('put'),
    delete: withAuth('delete'),
  };
};

export const anon = () => request(app);

// Registers a user through the API; returns { user, token }.
// role: 'admin' promotes them directly in the DB (there's no API for that).
export const registerUser = async ({ email = uniqueEmail(), password = PASSWORD, role } = {}) => {
  const res = await anon().post('/api/auth/register').send({ email, password }).expect(201);
  if (role === 'admin') res.body.user = await setRole(res.body.user.id, 'admin');
  return res.body;
};

// Empties the database and registers a new default user
export const resetStore = async () => {
  await clear();
  defaultToken = (await registerUser()).token;
};

// Creates an item through the API and returns the response body
export const createItem = async (data, token = defaultToken) => {
  const res = await api(token).post('/api/items').send(data).expect(201);
  return res.body;
};

// Creates items in order, one at a time, so creation order is deterministic
export const seed = async (list, token = defaultToken) => {
  const created = [];
  for (const data of list) created.push(await createItem(data, token));
  return created;
};
