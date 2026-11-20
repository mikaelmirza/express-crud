// Minimal migration runner: applies src/db/migrations/*.sql in filename order,
// each in its own transaction, and records what ran in schema_migrations.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from '../src/db/pool.js';
import { config } from '../src/config.js';

const dir = fileURLToPath(new URL('../src/db/migrations/', import.meta.url));

const client = await pool.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const pending = files.filter((f) => !applied.has(f));

  for (const file of pending) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`, { cause: err });
    }
  }

  const db = new URL(config.db.url).pathname.slice(1);
  console.log(pending.length ? `migrations complete (${db})` : `no pending migrations (${db})`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
