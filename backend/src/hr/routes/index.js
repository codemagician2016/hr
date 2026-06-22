'use strict';
// HR vertical API aggregator — mounted at /api/hr in backend/src/index.js.
// Each sub-router owns one HR domain area; controllers are tenant-scoped by
// req.user.businessId. Payroll + compliance register here as they are built
// (see docs/19-delivery-plan.md phasing).
const express = require('express');
const router = express.Router();

router.use('/employees', require('./employee.routes'));
router.use('/org', require('./org.routes'));
router.use('/leave', require('./leave.routes'));
router.use('/attendance', require('./attendance.routes'));
router.use('/compensation', require('./compensation.routes'));
router.use('/documents', require('./documents.routes'));
router.use('/assets', require('./assets.routes'));
router.use('/expenses', require('./expenses.routes'));
router.use('/loans', require('./loans.routes'));

// Talent (recruitment/ATS + performance). RBAC: recruitment -> canManageEmployees;
// performance -> canViewEmployees (read) / canManageEmployees (write). The offer
// pre-flight reuses the payroll engine's India 50% wage check.
const talent = require('../talent/routes');
router.use('/recruitment', talent.recruitment);
router.use('/performance', talent.performance);

// Payroll orchestration — operator API (RBAC: canRunPayroll / canApprovePayroll
// / canViewPayrollReports) and the ESS payslip API (customer session). The
// /me/payslips router uses the customer-auth middleware internally.
router.use('/payroll', require('../payroll/payroll.routes'));
router.use('/me/payslips', require('../payroll/mePayslips.routes'));

module.exports = router;
