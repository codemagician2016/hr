'use strict';

/**
 * bonus.routes.js — operator-facing Statutory Bonus API (Feature 22), mounted at
 * /api/hr/bonus. India-gated in the service (404 COUNTRY_NOT_SUPPORTED for NZ).
 *
 * RBAC reuses the payroll set (per spec §7):
 *   - create / compute / update / letters -> canRunPayroll
 *   - approve / publish                    -> canApprovePayroll
 *   - list / view / register               -> canViewPayrollReports
 * Maker-checker SoD (approver ≠ computedBy) is enforced in the service, not RBAC.
 * Mutations ride payrollMutationLimiter (reuse).
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { payrollMutationLimiter } = require('../../core/middleware/abuse.middleware');
const c = require('./bonus.controller');

router.use(protect);

router.post('/cycles', requirePermission('canRunPayroll'), c.createBonusCycle);
router.get('/cycles', requirePermission('canViewPayrollReports'), c.listBonusCycles);
router.get('/cycles/:id', requirePermission('canViewPayrollReports'), c.getBonusCycle);
router.patch('/cycles/:id', requirePermission('canRunPayroll'), c.updateBonusCycle);
router.post('/cycles/:id/compute', payrollMutationLimiter, requirePermission('canRunPayroll'), c.computeBonusCycle);
router.post('/cycles/:id/approve', payrollMutationLimiter, requirePermission('canApprovePayroll'), c.approveBonusCycle);
router.post('/cycles/:id/publish', payrollMutationLimiter, requirePermission('canApprovePayroll'), c.publishBonusSlips);
router.get('/cycles/:id/register', requirePermission('canViewPayrollReports'), c.getFormCRegister);

module.exports = router;
