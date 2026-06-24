'use strict';

/**
 * meArrears.routes.js — Employee Self-Service (ESS) Auto-Arrears, mounted at
 * /api/hr/me/arrears. Uses the CUSTOMER-auth middleware (req.customer) like the ESS
 * payslip + bonus routes. Surfaces the self-employee's own arrear slips (APPROVED+)
 * with the §89(1) relief figure + the Form 10E/39 prompt name.
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('./arrears.controller');

router.use(requireCustomer);
router.get('/', c.getMyArrears);

module.exports = router;
