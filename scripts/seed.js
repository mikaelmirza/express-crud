// Fills the dev database with demo items, so traces have realistic work to show
// (e.g. the 2-character search that can't use the trigram index).
//
//   npm run db:seed              # 100,000 items
//   npm run db:seed -- 1000000   # any count
//
// Items belong to a demo user, created if missing:
//   email:    demo@example.com
//   password: demo-password
//
// Refuses to run against a non-local database unless --force is given.
import { pool, closePool } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/auth/password.js';

const DEMO_EMAIL = 'demo@example.com';
const DEMO_PASSWORD = 'demo-password';

const args = process.argv.slice(2);
const force = args.includes('--force');
const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 100_000);

const ADJECTIVES = ['Oak', 'Walnut', 'Brass', 'Linen', 'Ceramic', 'Velvet', 'Steel', 'Rattan', 'Marble', 'Wool'];
const NOUNS = ['desk lamp', 'floor lamp', 'side table', 'bookshelf', 'armchair', 'rug', 'mirror', 'wall clock', 'vase', 'bench', 'stool', 'cushion'];

try {
  const host = new URL(config.db.url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host) && !force) {
    throw new Error(`Refusing to seed non-local database host "${host}". Pass --force if you're sure.`);
  }
  if (!Number.isInteger(count) || count < 1 || count > 10_000_000) {
    throw new Error('Count must be between 1 and 10,000,000');
  }

  const existing = await pool.query('SELECT id FROM users WHERE lower(email) = $1', [DEMO_EMAIL]);
  const userId =
    existing.rows[0]?.id ??
    (
      await pool.query(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
        [DEMO_EMAIL, await hashPassword(DEMO_PASSWORD)]
      )
    ).rows[0].id;

  const started = Date.now();
  // One set-based INSERT: much faster than inserting row by row.
  // Every 3rd item has a description and every 5th has no price;
  // creation times are spread over the past year.
  await pool.query(
    `INSERT INTO items (name, description, price, owner_id, created_at)
     SELECT
       ($2::text[])[1 + g % array_length($2::text[], 1)] || ' ' ||
       ($3::text[])[1 + (g / 10) % array_length($3::text[], 1)] || ' #' || g,
       CASE WHEN g % 3 = 0 THEN 'Handmade, item number ' || g END,
       CASE WHEN g % 5 <> 0 THEN round((5 + random() * 495)::numeric, 2) END,
       $4,
       now() - random() * interval '365 days'
     FROM generate_series(1, $1::int) AS g`,
    [count, ADJECTIVES, NOUNS, userId]
  );
  await pool.query('ANALYZE items');

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM items WHERE owner_id = $1', [userId]);
  console.log(`Inserted ${count.toLocaleString()} items in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`${DEMO_EMAIL} now owns ${rows[0].n.toLocaleString()} items (password: ${DEMO_PASSWORD})`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
