'use strict';

/**
 * meCompensation.routes.js — Employee Self-Service (ESS) compensation API,
 * mounted at /api/hr/me/compensation. Uses the CUSTOMER-auth middleware
 * (req.customer) because the ESS runs on the customer session, not an operator
 * session. SELF_ONLY: there is NO `:id` path, so cross-employee leakage is
 * structurally impossible. Terminated/inactive employees are locked out (404).
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/compensation.controller');

router.use(requireCustomer);

router.get('/', c.getMyCompensationEss);

module.exports = router;
