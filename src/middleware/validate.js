// Generic request validator.
// Usage: validate({ params: schema, query: schema, body: schema })
// On success, replaces req[key] with the parsed data (trimmed, coerced, unknown keys stripped).
// On failure, responds 400 with every issue across all locations.
// Named function so traces show "middleware - validateRequest", not "<anonymous>"
export const validate = (schemas) => function validateRequest(req, res, next) {
  const errors = [];

  for (const key of ['params', 'query', 'body']) {
    const schema = schemas[key];
    if (!schema) continue;

    const result = schema.safeParse(req[key]);
    if (result.success) {
      req[key] = result.data;
    } else {
      errors.push(
        ...result.error.issues.map((issue) => ({
          location: key,
          path: issue.path.join('.'),
          message: issue.message,
        }))
      );
    }
  }

  if (errors.length) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }
  next();
};
