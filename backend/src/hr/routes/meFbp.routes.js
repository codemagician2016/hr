'use strict';

/**
 * meFbp.routes.js — Feature 25. ESS Flexi-Benefits (FBP), mounted at /api/hr/me/fbp.
 * CUSTOMER session (requireCustomer); SELF_ONLY — the subject is resolved from the
 * session inside the controller, never from the client, so a cross-employee access
 * is structurally impossible. India-only (the controller country-gates → 422).
 *
 *   GET  /          → active plan, resolved envelope, current allocation, per-head
 *                     caps + live exempt/taxable, window status + deadline, regime.
 *   POST /          → save/submit allocation { lines:[{headId, annual}] } (window-gated).
 *   POST /preview   → pure live impact (computeFbpSplit + tax-with/without).
 *
 * Bills upload via the F20 ESS path (/api/hr/me/proofs) with the FBP_* claim types.
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/meFbp.controller');

router.use(requireCustomer);

// /preview must precede the bare POST so it isn't swallowed.
router.post('/preview', c.previewMyFbp);
router.get('/', c.getMyFbp);
router.post('/', c.saveMyFbp);

module.exports = router;
