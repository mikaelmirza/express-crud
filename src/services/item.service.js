import { query } from '../db/pool.js';

// Columns returned to the API, with snake_case mapped to camelCase
const COLUMNS = `
  id, name, description, price,
  owner_id AS "ownerId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

// Allowlist: API sort field -> SQL expression. Column names can't be query
// parameters, so only values from this map are ever interpolated into SQL.
// lower(name) makes name sorting case-insensitive regardless of DB collation.
const SORT_COLUMNS = {
  createdAt: 'created_at',
  name: 'lower(name)',
  price: 'price',
};

// Allowlist: API field -> column that clients may update
const UPDATABLE_COLUMNS = {
  name: 'name',
  description: 'description',
  price: 'price',
};

// Collects query values and hands out their placeholders in order:
// params.add(x) returns "$1", the next call "$2", and so on.
// Values never go into the SQL text, only into params.values.
const createParams = () => {
  const values = [];
  return { values, add: (value) => `$${values.push(value)}` };
};

// Escapes LIKE wildcards so user text matches literally: "50%" finds the text
// "50%", not "50 followed by anything". Backslash is Postgres's default escape.
const escapeLike = (text) => text.replace(/[\\%_]/g, '\\$&');

// Filters echoed back in meta.filters (only those actually applied)
const FILTER_KEYS = ['q', 'minPrice', 'maxPrice', 'hasPrice', 'createdAfter', 'createdBefore', 'ownerId'];

// Builds the WHERE clause for items this user may access, plus any filters.
// Ownership is enforced here for every query, not by fetching and then
// checking. Admins see everything; everyone else only their own items.
// Filters are ANDed with ownership, so they can only ever narrow results.
const buildWhere = (user, params, { id, ...filters } = {}) => {
  const conditions = [];

  if (id !== undefined) conditions.push(`id = ${params.add(id)}`);
  if (user.role !== 'admin') conditions.push(`owner_id = ${params.add(user.id)}`);

  if (filters.q) {
    const pattern = params.add(`%${escapeLike(filters.q)}%`); // one value, used twice
    conditions.push(`(name ILIKE ${pattern} OR description ILIKE ${pattern})`);
  }
  // Comparisons with NULL are never true, so price ranges exclude unpriced items
  if (filters.minPrice != null) conditions.push(`price >= ${params.add(filters.minPrice)}`);
  if (filters.maxPrice != null) conditions.push(`price <= ${params.add(filters.maxPrice)}`);
  if (filters.hasPrice != null) conditions.push(filters.hasPrice ? 'price IS NOT NULL' : 'price IS NULL');
  // Half-open range [after, before): back-to-back ranges never count an item twice
  if (filters.createdAfter) conditions.push(`created_at >= ${params.add(filters.createdAfter)}`);
  if (filters.createdBefore) conditions.push(`created_at < ${params.add(filters.createdBefore)}`);
  if (filters.ownerId) conditions.push(`owner_id = ${params.add(filters.ownerId)}`);

  return conditions.length ? conditions.join(' AND ') : 'TRUE';
};

export const findAll = async (
  user,
  { page = 1, limit = 20, sort = 'createdAt', order = 'asc', ...rest } = {}
) => {
  const column = SORT_COLUMNS[sort];
  if (!column) throw new Error(`Unsupported sort field: ${sort}`);
  const direction = order === 'desc' ? 'DESC' : 'ASC';

  const filters = Object.fromEntries(
    FILTER_KEYS.filter((key) => rest[key] !== undefined).map((key) => [key, rest[key]])
  );

  // The list and count queries each need their own params:
  // Postgres rejects values that the SQL never references.
  const listParams = createParams();
  const listWhere = buildWhere(user, listParams, filters);
  const countParams = createParams();
  const countWhere = buildWhere(user, countParams, filters);

  // NULLS LAST keeps missing values at the end in both directions.
  // created_at, id break ties so paging is deterministic.
  const [{ rows }, { rows: [{ total }] }] = await Promise.all([
    query(
      `SELECT ${COLUMNS} FROM items
       WHERE ${listWhere}
       ORDER BY ${column} ${direction} NULLS LAST, created_at ASC, id ASC
       LIMIT ${listParams.add(limit)} OFFSET ${listParams.add((page - 1) * limit)}`,
      listParams.values
    ),
    query(`SELECT count(*)::int AS total FROM items WHERE ${countWhere}`, countParams.values),
  ]);

  return {
    data: rows,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      sort,
      order,
      filters,
    },
  };
};

export const findById = async (user, id) => {
  const params = createParams();
  const where = buildWhere(user, params, { id });
  const { rows } = await query(`SELECT ${COLUMNS} FROM items WHERE ${where}`, params.values);
  return rows[0] ?? null;
};

// The owner always comes from the authenticated user, never the request body
export const create = async (user, { name, description = null, price = null }) => {
  const { rows } = await query(
    `INSERT INTO items (name, description, price, owner_id)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNS}`,
    [name, description, price, user.id]
  );
  return rows[0];
};

export const update = async (user, id, data) => {
  const fields = Object.entries(data).filter(
    ([key, value]) => Object.hasOwn(UPDATABLE_COLUMNS, key) && value !== undefined
  );
  if (fields.length === 0) return findById(user, id);

  const params = createParams();
  const assignments = fields.map(([key, value]) => `${UPDATABLE_COLUMNS[key]} = ${params.add(value)}`);
  const where = buildWhere(user, params, { id });

  const { rows } = await query(
    `UPDATE items
     SET ${assignments.join(', ')}, updated_at = now()
     WHERE ${where}
     RETURNING ${COLUMNS}`,
    params.values
  );
  return rows[0] ?? null;
};

export const remove = async (user, id) => {
  const params = createParams();
  const where = buildWhere(user, params, { id });
  const { rowCount } = await query(`DELETE FROM items WHERE ${where}`, params.values);
  return rowCount > 0;
};

// Test helper: empties items and users between tests
export const clear = async () => {
  await query('TRUNCATE items, users');
};
