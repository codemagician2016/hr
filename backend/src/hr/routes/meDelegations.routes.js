'use strict';

/**
 * meDelegations.routes.js — Feature 10 §7.3 ESS "Delegate while I'm away".
 * Mounted at /api/hr/me/delegations (see routes/index.js). CUSTOMER session
 * (ESS) — the delegating user is resolved from the session, never from a
 * client-supplied id. The admin tenant-wide view is on /api/hr/approvals/delegations.
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/delegations.controller');

router.use(requireCustomer);

router.get('/', c.listMine);
router.post('/', c.create);
router.delete('/:id', c.revoke);

module.exports = router;
