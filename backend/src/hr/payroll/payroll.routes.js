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
const { protect, requirePermission, requireAnyPermission } = require('../../core/middleware/auth.middleware');
const { payrollMutationLimiter } = require('../../core/middleware/abuse.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');
const c = require('./payroll.controller');
// FLAG (Feature 31 — shared edit): preview the in-service leave-encashment requests a
// run will pay / has paid (read-only, reports-gated). The payout itself rides the
// existing compute/disburse flow — no new mutation route.
const enc = require('../controllers/encashment.controller');
// FLAG (India salary disbursement — shared edit): convert a FROZEN/APPROVED run into a
// bank-uploadable salary-advice batch (+ optional payout-gateway path) with UTR
// reconciliation. create/file/reconcile gated on canRunPayroll; reads on
// canViewPayrollReports. India-only (the service 422s a non-IN run).
const disb = require('./disbursement/disbursement.controller');

// Every payroll route requires an authenticated operator. `protect` runs first
// so the per-tenant rate-limit key (req.user.businessId) is populated.
router.use(protect);

// ── India salary disbursement (NET-NEW) ──
// Money-moving create/reconcile carry the per-(tenant,IP) mutation limiter on top of
// the RBAC gate, mirroring compute/approve. Lists/reads are reports-gated. The file
// download is a maker action (it materialises beneficiary account numbers).
router.post('/runs/:id/disbursement', payrollMutationLimiter, requirePermission('canRunPayroll'), disb.createBatch);
router.get('/runs/:id/disbursement', requirePermission('canViewPayrollReports'), disb.listBatches);
router.get('/disbursement/:batchId', requirePermission('canViewPayrollReports'), disb.getBatch);
router.get('/disbursement/:batchId/file', requirePermission('canRunPayroll'), disb.downloadFile);
router.post('/disbursement/:batchId/reconcile', payrollMutationLimiter, requirePermission('canRunPayroll'), disb.reconcile);

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
// Feature 31 — preview the in-service leave encashments this run pays / has paid.
// F1-scoped (finding #1): attachSelfEmployee → withEmployeeScope populates req.scope so
// the handler can filter BOTH the paid + queued lists to the caller's sub-tree. Without
// the middleware req.scope is undefined and the preview leaks every employee's name +
// amount tenant-wide. Mirrors the tax-projection mount below.
router.get(
  '/runs/:id/encashments',
  requirePermission('canViewPayrollReports'),
  attachSelfEmployee,
  withEmployeeScope('canViewPayrollReports'),
  enc.runEncashments,
);
router.get('/runs/:id/files/:kind', requirePermission('canViewPayrollReports'), c.getFile);

// ── Feature 7 — guided run orchestration + lifecycle past APPROVED ──
//   inputs / compute → maker (canRunPayroll); variance read → reports;
//   submit → maker; send-back / approve / publish / pay → checker (canApprovePayroll);
//   file / close → finance (canViewPayrollReports). Maker-checker SoD is enforced
//   in the service (approver ≠ preparer/submitter), not by RBAC alone.
// FLAG (shared edit — entity picker reachable by several payroll personas):
// the entity list is a read-only lookup used by the run pickers AND by the
// reports-/statutory-only pages (registers, compliance calendar, comp/structures).
// Gate on ANY of run-payroll / view-reports / manage-statutory so a legitimate
// reports- or compliance-only role can populate the dropdown instead of dead-ending
// on a silent 403. The data returned is non-sensitive (entity code/name/state).
router.get(
  '/entities',
  requireAnyPermission(['canRunPayroll', 'canViewPayrollReports', 'canManageStatutory']),
  c.listRunEntities,
);
// Feature 21 — LWF statutory framework read (per-state EE/ER/frequency/exclusion),
// India-only. Any payroll.read role (HR_ADMIN/PAYROLL_MANAGER/FINANCE_VIEWER).
router.get('/statutory/lwf', requirePermission('canViewPayrollReports'), c.getLwfFramework);
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

// ── Feature 15 — operator read-only tax-projection mirror (payroll desk) ──
// Behind canViewPayrollReports + F1 scope: withEmployeeScope 404s an employeeId
// outside the caller's accessible set BEFORE the handler computes (no IDOR, no
// "forbidden" leak). India-only (the assembler 422s for non-IN). Read-only.
router.get(
  '/employees/:employeeId/tax-projection',
  requirePermission('canViewPayrollReports'),
  attachSelfEmployee,
  withEmployeeScope('canViewPayrollReports', { idParam: 'employeeId' }),
  c.getEmployeeTaxProjection,
);
router.get(
  '/employees/:employeeId/tax-projection/pdf',
  requirePermission('canViewPayrollReports'),
  attachSelfEmployee,
  withEmployeeScope('canViewPayrollReports', { idParam: 'employeeId' }),
  c.getEmployeeTaxProjectionPdf,
);

// FLAG (Feature 24 — NEW mount): Year-end Form 16 (Part A + Part B) + Form 24Q.
// India-gated in the service; F1-scoped reads; maker-checker SoD on approve; issue
// rides the existing letters engine. Paths: /payroll/form16/* + /payroll/form24q/*.
router.use('/', require('../tax/form16/form16.routes'));

module.exports = router;
