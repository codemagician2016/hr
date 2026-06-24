'use strict';

/**
 * meBonus.routes.js — Employee Self-Service (ESS) Statutory Bonus, mounted at
 * /api/hr/me/bonus. Uses the CUSTOMER-auth middleware (req.customer) like the ESS
 * payslip routes. Surfaces the self-employee's bonus awards, but only for
 * APPROVED+ cycles (PUBLISHED-gated, exactly like getMyPayslip).
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('./bonus.controller');

router.use(requireCustomer);
router.get('/', c.getMyBonus);

module.exports = router;
