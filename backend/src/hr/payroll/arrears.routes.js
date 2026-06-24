'use strict';

/**
 * arrears.routes.js — operator-facing Auto-Arrear API (Feature 27), mounted at
 * /api/hr/arrears. India-gated in the service (404 COUNTRY_NOT_SUPPORTED for NZ).
 *
 * RBAC reuses the payroll set (per spec §6) — NO new RBAC primitives:
 *   - detect / create / update / compute -> canRunPayroll
 *   - approve / publish                  -> canApprovePayroll
 *   - list / view                        -> canViewPayrollReports
 * Maker-checker SoD (approver ≠ computedBy) is enforced in the service, not RBAC.
 * Mutations ride payrollMutationLimiter (reuse, same as bonus).
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { payrollMutationLimiter } = require('../../core/middleware/abuse.middleware');
const c = require('./arrears.controller');

router.use(protect);

router.get('/detect', requirePermission('canRunPayroll'), c.detect);
router.post('/cycles', requirePermission('canRunPayroll'), c.createCycle);
router.get('/cycles', requirePermission('canViewPayrollReports'), c.listCycles);
router.get('/cycles/:id', requirePermission('canViewPayrollReports'), c.getCycle);
router.patch('/cycles/:id', requirePermission('canRunPayroll'), c.updateCycle);
router.post('/cycles/:id/compute', payrollMutationLimiter, requirePermission('canRunPayroll'), c.computeCycle);
router.post('/cycles/:id/approve', payrollMutationLimiter, requirePermission('canApprovePayroll'), c.approveCycle);
router.post('/cycles/:id/cancel', payrollMutationLimiter, requirePermission('canApprovePayroll'), c.cancelCycle);
router.post('/cycles/:id/publish', payrollMutationLimiter, requirePermission('canApprovePayroll'), c.publishCycle);

module.exports = router;
