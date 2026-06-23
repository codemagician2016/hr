'use strict';

/**
 * meApprovals.routes.js — Feature 10 (slice 10e) ESS-facing unified approvals
 * inbox + act, mounted at /api/hr/me/approvals. CUSTOMER session (req.customer).
 * The caller's portal User is resolved from the session inside the controller; no
 * id is accepted from the client. Decisions go through the SAME engine the
 * operator path uses (SoD / version / active-step guards preserved).
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/meApprovals.controller');

router.use(requireCustomer);

router.get('/', c.inbox);
router.get('/colleagues', c.colleagues);
router.post('/preview', c.preview);
router.post('/:id/decide', c.decide);

module.exports = router;
