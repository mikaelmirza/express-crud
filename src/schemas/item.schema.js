import { z } from 'zod';

export const itemIdParams = z.object({
  id: z.string().uuid(),
});

// Allowlist of fields clients may sort by
export const SORTABLE_FIELDS = ['createdAt', 'name', 'price'];

// Optional query param where blank means "not given". Search boxes and forms
// often send `?q=` or `?minPrice=`, and z.coerce.number() would turn "" into 0.
const optionalParam = (schema) =>
  z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }, schema.optional());

// Query strings are always text. z.coerce.boolean() would turn "false" into true.
const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

// A full ISO timestamp with a timezone, or a plain date (taken as midnight UTC).
// z.coerce.date() is avoided because it accepts things like "1" (= 1970).
const dateOrDateTime = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()], {
    error: 'Expected a date (YYYY-MM-DD) or an ISO timestamp with a timezone',
  })
  .transform((value) => (value.length === 10 ? `${value}T00:00:00Z` : value));

// Query strings arrive as strings, so coerce to numbers; defaults apply when omitted
export const listItemsQuery = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.enum(SORTABLE_FIELDS).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('asc'),

    // Filters: all optional, combined with AND
    q: optionalParam(z.string().max(100)),
    minPrice: optionalParam(z.coerce.number().nonnegative()),
    maxPrice: optionalParam(z.coerce.number().nonnegative()),
    hasPrice: optionalParam(booleanString),
    createdAfter: optionalParam(dateOrDateTime),
    createdBefore: optionalParam(dateOrDateTime),
    ownerId: optionalParam(z.uuid()),
  })
  .refine((f) => f.minPrice == null || f.maxPrice == null || f.minPrice <= f.maxPrice, {
    path: ['minPrice'],
    message: 'minPrice must not be greater than maxPrice',
  })
  .refine(
    (f) => !f.createdAfter || !f.createdBefore || new Date(f.createdAfter) < new Date(f.createdBefore),
    { path: ['createdAfter'], message: 'createdAfter must be before createdBefore' }
  );

export const createItemBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
  price: z.number().nonnegative().optional(),
});

// Update = same fields, all optional, but at least one required
export const updateItemBody = createItemBody
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  });
