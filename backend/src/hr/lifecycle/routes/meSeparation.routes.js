'use strict';

/**
 * meSeparation.routes.js — exiting-employee SELF-SERVICE separation API, mounted
 * at /api/hr/me/separation (Feature 4 §4.6 ESS, §6, slice 4f).
 *
 * Uses the CUSTOMER-auth middleware (req.customer): the ESS runs on the customer
 * session, not an operator session. The subject employee is derived ENTIRELY from
 * the session — there is NO :employeeId in any path, so a cross-employee read /
 * write is structurally impossible. There is intentionally no permission/scope
 * middleware here: the surface is self-only by construction.
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/meSeparation.controller');

router.use(requireCustomer);

router.get('/', c.getMySeparation);
router.post('/resign', c.resign);
router.get('/fnf', c.getMyFnf);
router.get('/assets', c.listMyAssets);
router.post('/assets/:id/acknowledge', c.acknowledgeAsset);

module.exports = router;
