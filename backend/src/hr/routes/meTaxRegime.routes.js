'use strict';

/**
 * meTaxRegime.routes.js — Feature 15/25. ESS income-tax REGIME ELECTION, mounted at
 * /api/hr/me/tax/regime. CUSTOMER session (req.customer); SELF_ONLY — the subject
 * employee is resolved from the session inside the controller, never from the client,
 * so a cross-employee election is structurally impossible.
 *
 *   GET / → elected + effective regime + window/lock state + OLD-vs-NEW comparison.
 *   PUT / → elect NEW|OLD for the current FY (honouring the lock/window).
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/meTaxRegime.controller');

router.use(requireCustomer);

router.get('/', c.getRegime);
router.put('/', c.putRegime);
router.post('/', c.putRegime); // alias — some ESS clients POST elections

module.exports = router;
