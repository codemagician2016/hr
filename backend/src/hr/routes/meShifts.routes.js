'use strict';

/**
 * meShifts.routes.js — Feature 29 ESS shift-swap API, mounted at /api/hr/me/shifts.
 * CUSTOMER session (req.customer); SELF_ONLY — the subject employee is resolved from
 * the session inside the controller, never from a path/body (a cross-employee
 * file/consent/withdraw is structurally impossible). The consent endpoint additionally
 * 404s for any caller who is not the counterparty (IDOR-safe).
 */

const express = require('express');

const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/meAttendance.controller');

router.use(requireCustomer);

router.get('/swaps', c.listMySwaps);
router.post('/swaps', c.createMySwap);
router.post('/swaps/:id/consent', c.consentMySwap);
router.post('/swaps/:id/withdraw', c.withdrawMySwap);

module.exports = router;
