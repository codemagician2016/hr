const { ZodError } = require('zod');

// Express middleware that validates req.body against a Zod schema.
// On success, replaces req.body with the parsed (coerced) result so the
// controller gets strongly-typed, already-validated fields.
// On failure, returns 400 with the first error message in the same shape
// existing controllers use: { message: "..." }.
function validateBody(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.body);
      req.body = parsed;
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const first = err.issues[0];
        const path = first.path.join('.');
        const message = path ? `${path}: ${first.message}` : first.message;
        return res.status(400).json({ message });
      }
      next(err);
    }
  };
}

// Same, for req.query (useful on GET endpoints).
function validateQuery(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.query);
      req.query = parsed;
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const first = err.issues[0];
        const path = first.path.join('.');
        const message = path ? `${path}: ${first.message}` : first.message;
        return res.status(400).json({ message });
      }
      next(err);
    }
  };
}

module.exports = { validateBody, validateQuery };
