'use strict';

/**
 * payroll.routes.js — operator-facing payroll API, mounted at /api/hr/payroll.
 *
 * RBAC (per the build brief):
 *   - create / compute        -> canRunPayroll
 *   - approve (maker-checker)  -> canApprovePayroll
 *   - list / view / files      -> canViewPayrollReports
 *
 * The ESS routes (/api/hr/me/payslips) are mounted separately by the HR
 * aggregator with the customer-auth middleware (see ./mePayslips.routes.js).
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('./payroll.controller');

// Every payroll route requires an authenticated operator.
router.use(protect);

// ── Pay runs ──
router.post('/runs', requirePermission('canRunPayroll'), c.createRun);
router.post('/runs/:id/compute', requirePermission('canRunPayroll'), c.computeRun);
router.post('/runs/:id/approve', requirePermission('canApprovePayroll'), c.approveRun);
router.get('/runs', requirePermission('canViewPayrollReports'), c.listRuns);
router.get('/runs/:id', requirePermission('canViewPayrollReports'), c.getRun);
router.get('/runs/:id/payslips', requirePermission('canViewPayrollReports'), c.getRunPayslips);
router.get('/runs/:id/files/:kind', requirePermission('canViewPayrollReports'), c.getFile);

// ── Payslips (operator view) ──
router.get('/payslips/:id', requirePermission('canViewPayrollReports'), c.getPayslip);

module.exports = router;
