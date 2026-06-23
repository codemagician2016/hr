'use strict';

/**
 * meLeave.routes.js — Employee Self-Service (ESS) leave API, mounted at
 * /api/hr/me/leave. Uses the CUSTOMER-auth middleware (req.customer): the ESS runs
 * on the customer session, not an operator session.
 *
 * SELF_ONLY by construction — the subject employee is resolved from the session
 * inside the controller; there is NO employeeId in any path or accepted from a
 * body, so applying / listing balances+requests / cancelling can only ever touch
 * the caller's own leave. Terminated/inactive employees are locked out (404).
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/meLeave.controller');

router.use(requireCustomer);

router.get('/types', c.listTypes);
router.get('/balances', c.listBalances);
router.get('/requests', c.listRequests);
router.post('/requests', c.applyForLeave);
router.post('/requests/:id/cancel', c.cancelRequest);

module.exports = router;
