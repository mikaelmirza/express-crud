import { query } from '../db/pool.js';
import { HttpError } from '../utils/httpError.js';

// Safe to return to clients — never includes password_hash
const PUBLIC_COLUMNS = `id, email, role, created_at AS "createdAt"`;

const UNIQUE_VIOLATION = '23505';

export const create = async ({ email, passwordHash, role = 'user' }) => {
  try {
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING ${PUBLIC_COLUMNS}`,
      [email, passwordHash, role]
    );
    return rows[0];
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw new HttpError(409, 'Email is already registered');
    throw err;
  }
};

export const findById = async (id) => {
  const { rows } = await query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
};

// Only for login: the one place the hash leaves the database
export const findByEmailWithPassword = async (email) => {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS}, password_hash AS "passwordHash"
     FROM users WHERE lower(email) = lower($1)`,
    [email]
  );
  return rows[0] ?? null;
};

export const setRole = async (id, role) => {
  const { rows } = await query(
    `UPDATE users SET role = $2 WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
    [id, role]
  );
  return rows[0] ?? null;
};
