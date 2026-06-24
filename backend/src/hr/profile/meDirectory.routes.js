'use strict';

/**
 * meDirectory.routes.js — Cycle 1 ESS Company Directory, mounted at
 * /api/hr/me/directory (CUSTOMER session). A READ-only colleague directory: every
 * GET is tenant-scoped and exposes ONLY safe work/professional fields (see
 * meDirectory.controller — the Prisma select is the privacy boundary).
 *
 * The single write is the SELF opt-out toggle (PATCH /preferences) which edits the
 * caller's OWN row only; no `:id` ever names the SUBJECT of a write. `:id` on the
 * detail GET names a COLLEAGUE to VIEW and is re-scoped to the tenant + active
 * whitelist (out-of-tenant / inactive → 404). Static paths are registered BEFORE the
 * `/:id` param route so /filters and /preferences are not swallowed by it.
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('./meDirectory.controller');

router.use(requireCustomer);

router.get('/', c.list);
router.get('/filters', c.filters);
router.get('/preferences', c.getPreferences);
router.patch('/preferences', c.updatePreferences);
router.get('/:id', c.detail); // colleague work-profile (read-only); keep LAST (param route)

module.exports = router;
