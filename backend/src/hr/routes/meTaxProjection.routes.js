'use strict';

/**
 * meTaxProjection.routes.js — Feature 15. Employee Self-Service (ESS) India
 * income-tax projection, mounted at /api/hr/me/tax-projection. CUSTOMER session
 * (req.customer); SELF_ONLY — the subject employee is resolved from the session
 * inside the controller, never from the client, so a cross-employee read is
 * structurally impossible.
 *
 *   GET /         → the full IT-computation statement.
 *   GET /regimes  → the lightweight OLD-vs-NEW comparison.
 *   GET /pdf      → the branded IT-computation PDF.
 *
 * India-only: the assembler country-gates (422 COUNTRY_UNSUPPORTED for non-IN).
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/meTaxProjection.controller');

router.use(requireCustomer);

// /pdf and /regimes must precede / so they are not swallowed.
router.get('/pdf', c.getProjectionPdf);
router.get('/regimes', c.getRegimes);
router.get('/', c.getProjection);

module.exports = router;
