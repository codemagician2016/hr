'use strict';

/**
 * meProofs.routes.js — Feature 20 slice 20b/20e. ESS investment-proof upload +
 * Form 12BB, mounted at /api/hr/me/proofs. CUSTOMER session (requireCustomer);
 * SELF_ONLY — the subject employee is resolved from the session inside the
 * controller, never from the client, so a cross-employee write is structurally
 * impossible. India-only (the controller country-gates → 422 for non-IN).
 *
 *   GET    /                  → my proofs + window status + per-claim rollup.
 *   GET    /form12bb.pdf?fy=  → Form 12BB from the verified record (precede /:id).
 *   POST   /                  → upload one proof (window OPEN, OLD regime).
 *   DELETE /:id               → withdraw an own PENDING proof while OPEN.
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('../tax/investmentProof/meProofs.controller');

router.use(requireCustomer);

// /form12bb.pdf must precede the bare GET and the /:id DELETE so it isn't swallowed.
router.get('/form12bb.pdf', c.getForm12bbPdf);
router.get('/', c.listMyProofs);
router.post('/', c.uploadProof);
router.delete('/:id', c.withdrawProof);

module.exports = router;
