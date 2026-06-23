'use strict';

/**
 * mePayslips.routes.js — Employee Self-Service (ESS) payslip API, mounted at
 * /api/hr/me/payslips. Uses the CUSTOMER-auth middleware (req.customer) because
 * the ESS runs on the customer session, not an operator session.
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('./payroll.controller');

// Every ESS route requires an authenticated customer (employee portal session).
router.use(requireCustomer);

router.get('/', c.getMyPayslips);
// Security fix (§6.6): the employee's OWN payslip PDF/text — scoped to the
// employee + PUBLISHED. Must precede /:id so "pdf" is not swallowed as an id.
router.get('/:id/pdf', c.getMyPayslipPdf);
router.get('/:id', c.getMyPayslip);

module.exports = router;
