# Input validation schemas (Zod)

This directory holds Zod schemas used by the backend to validate incoming
request bodies. Schemas are the **single source of truth** for what shape /
rules a given endpoint accepts.

## Why

Before this directory existed, every controller had its own hand-written
regex and `if (!x) return res.status(400)...` ladder. Rules drifted
(e.g. the email regex was stricter in `auth` than in `business`), and
adding a new field was easy to forget in half the places.

Zod gives us:
- One schema per endpoint, composable from shared fields in `common.js`
- Automatic 400 response with a clear error message
- Parsed + coerced data in `req.body` inside the controller (no more
  `Number(x)` / `String(x).trim()` sprinkled around)

## How to use

```js
// 1. Define / import a schema (endpoint-specific or composed from common.js)
const { createServiceSchema } = require('../lib/schemas/service.schema');

// 2. Wire it into the route via validateBody middleware
const { validateBody } = require('../lib/validate');
router.post('/services',
  requireAuth,
  validateBody(createServiceSchema),
  servicesController.create,
);

// 3. In the controller, req.body is already validated + coerced
async function create(req, res) {
  const { name, duration, price } = req.body; // types trusted
  // …
}
```

## Files

- `common.js` — reusable field schemas (email, password, phone, date, time)
- `booking.schema.js` — customer booking creation
- `signup.schema.js` — business-admin + customer signup (disposable-email
  block lives here, not in each controller)
- `service.schema.js` — create + update

## Adoption plan

Existing controllers still contain their hand-written validation. That's
intentional — we add Zod to **new** endpoints first, and migrate old ones
one-at-a-time only when they're being touched for other reasons. Don't do
a big-bang refactor; the manual checks work and the risk isn't worth it.
