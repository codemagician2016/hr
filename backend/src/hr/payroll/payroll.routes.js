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
const { payrollMutationLimiter } = require('../../core/middleware/abuse.middleware');
const c = require('./payroll.controller');

// Every payroll route requires an authenticated operator. `protect` runs first
// so the per-tenant rate-limit key (req.user.businessId) is populated.
router.use(protect);

// ── Pay runs ──
// compute + approve are heavy, money-moving mutations — rate-limited per
// (tenant, IP) by payrollMutationLimiter on top of the RBAC permission gate.
router.post('/runs', requirePermission('canRunPayroll'), c.createRun);
router.post('/runs/:id/compute', payrollMutationLimiter, requirePermission('canRunPayroll'), c.computeRun);
router.post('/runs/:id/freeze', payrollMutationLimiter, requirePermission('canRunPayroll'), c.freezeRun);
router.post('/runs/:id/approve', payrollMutationLimiter, requirePermission('canApprovePayroll'), c.approveRun);
router.get('/runs', requirePermission('canViewPayrollReports'), c.listRuns);
router.get('/runs/:id', requirePermission('canViewPayrollReports'), c.getRun);
router.get('/runs/:id/payslips', requirePermission('canViewPayrollReports'), c.getRunPayslips);
router.get('/runs/:id/files/:kind', requirePermission('canViewPayrollReports'), c.getFile);

// ── Feature 7 — guided run orchestration + lifecycle past APPROVED ──
//   inputs / compute → maker (canRunPayroll); variance read → reports;
//   submit → maker; send-back / approve / publish / pay → checker (canApprovePayroll);
//   file / close → finance (canViewPayrollReports). Maker-checker SoD is enforced
//   in the service (approver ≠ preparer/submitter), not by RBAC alone.
router.get('/entities', requirePermission('canRunPayroll'), c.listRunEntities);
router.get('/runs/:id/inputs-checklist', requirePermission('canRunPayroll'), c.getInputsChecklist);
router.post('/runs/:id/inputs/one-time', requirePermission('canRunPayroll'), c.upsertOneTimeInput);
router.get('/runs/:id/variance', requirePermission('canViewPayrollReports'), c.getVariance);
router.post('/runs/:id/variance', payrollMutationLimiter, requirePermission('canViewPayrollReports'), c.getVariance);
router.post('/runs/:id/submit', payrollMutationLimiter, requirePermission('canRunPayroll'), c.submitRun);
router.post('/runs/:id/send-back', payrollMutationLimiter, requirePermission('canApprovePayroll'), c.sendBackRun);
router.post('/runs/:id/payslips/publish', payrollMutationLimiter, requirePermission('canApprovePayroll'), c.publishRun);
router.post('/runs/:id/pay', payrollMutationLimiter, requirePermission('canApprovePayroll'), c.disburseRun);
router.post('/runs/:id/file', payrollMutationLimiter, requirePermission('canViewPayrollReports'), c.fileRun);
router.post('/runs/:id/close', payrollMutationLimiter, requirePermission('canViewPayrollReports'), c.closeRun);
router.post('/runs/:id/cancel', payrollMutationLimiter, requirePermission('canRunPayroll'), c.cancelRun);
router.post('/runs/:id/reopen', payrollMutationLimiter, requirePermission('canRunPayroll'), c.reopenRun);

// ── Payslips (operator view) ──
router.get('/payslips/:id', requirePermission('canViewPayrollReports'), c.getPayslip);
// Operator payslip PDF — the "View" target. Renders the SAME branded PDF as ESS
// from the frozen snapshot (finding #23), tenant-scoped behind reports RBAC.
router.get('/payslips/:id/pdf', requirePermission('canViewPayrollReports'), c.getPayslipPdf);

module.exports = router;
