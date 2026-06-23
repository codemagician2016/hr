'use strict';

/**
 * me-letters.routes.js — Employee Self-Service (ESS) "My Letters" API, mounted at
 * /api/hr/me/letters (Feature 09 §4.5 ESS table, slice 9F).
 *
 * Uses the CUSTOMER-auth middleware (req.customer): the ESS runs on the customer
 * session, not an operator session. The subject employee is derived ENTIRELY from
 * the session (workEmail / personalEmail / linked User) — there is NO :employeeId in
 * the path, so a cross-employee read is structurally impossible. Returns ONLY the
 * caller's own ISSUED, non-voided letters; an out-of-band id ⇒ 404 (never 403).
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/meLetters.controller');

router.use(requireCustomer);

// own ISSUED non-voided letters (with fileHash tamper badge)
router.get('/', c.listMyLetters);
// request a letter into the HR queue (reuses DocumentRequest) — placed before /:id
// so "requests" can never be swallowed as an :id download segment.
router.post('/requests', c.createLetterRequest);
// stream the caller's own letter PDF (self-only; out-of-band ⇒ 404)
router.get('/:id/download', c.downloadMyLetter);

module.exports = router;
