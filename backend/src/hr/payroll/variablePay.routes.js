'use strict';

/**
 * variablePay.routes.js — operator-facing Variable-Pay / Incentive API (Feature 46,
 * Phase 4), mounted at /api/hr/variable-pay. A sibling mount of bonus/arrears within
 * the payroll domain (the mirror the brief asks for).
 *
 * RBAC (per brief):
 *   - scheme + cycle authoring (create/update/delete/compute/patch) -> canManageCompensation
 *   - approve                                                        -> canApprovePayroll
 *   - list / view                                                    -> canViewPayrollReports
 * Maker-checker SoD (approver ≠ computedBy) is enforced in the service, not RBAC.
 * Mutations ride payrollMutationLimiter (reuse).
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { payrollMutationLimiter } = require('../../core/middleware/abuse.middleware');
const c = require('./variablePay.controller');

router.use(protect);

// Schemes (reusable rules).
router.post('/schemes', requirePermission('canManageCompensation'), c.createScheme);
router.get('/schemes', requirePermission('canViewPayrollReports'), c.listSchemes);
router.get('/schemes/:id', requirePermission('canViewPayrollReports'), c.getScheme);
router.patch('/schemes/:id', requirePermission('canManageCompensation'), c.updateScheme);
router.delete('/schemes/:id', requirePermission('canManageCompensation'), c.deleteScheme);

// Cycles (one payout period).
router.post('/cycles', payrollMutationLimiter, requirePermission('canManageCompensation'), c.createCycle);
router.get('/cycles', requirePermission('canViewPayrollReports'), c.listCycles);
router.get('/cycles/:id', requirePermission('canViewPayrollReports'), c.getCycle);
router.post('/cycles/:id/compute', payrollMutationLimiter, requirePermission('canManageCompensation'), c.computeCycle);
router.post('/cycles/:id/approve', payrollMutationLimiter, requirePermission('canApprovePayroll'), c.approveCycle);
router.post('/cycles/:id/cancel', payrollMutationLimiter, requirePermission('canManageCompensation'), c.cancelCycle);

// Awards (per-employee snapshot).
router.get('/cycles/:id/awards', requirePermission('canViewPayrollReports'), c.listAwards);
router.patch('/cycles/:id/awards/:awardId', requirePermission('canManageCompensation'), c.patchAward);

module.exports = router;
