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

// Open shifts (claim an unassigned shift → F10 OPEN_SHIFT_CLAIM manager confirm).
// The literal /open/claims paths are declared BEFORE /open/:id/claim so the router
// never treats "claims" as an :id.
router.get('/open', c.listOpenShifts);
router.get('/open/claims', c.listMyOpenClaims);
router.post('/open/claims/:id/withdraw', c.withdrawOpenClaim);
router.post('/open/:id/claim', c.claimOpenShift);

module.exports = router;
