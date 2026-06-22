'use strict';

/**
 * reports.routes.js — HR reports/analytics API, mounted at /api/hr/reports.
 *
 * Every report is read-only and tenant-scoped (req.user.businessId). The whole
 * surface is gated by canViewPayrollReports — the same capability that guards
 * payroll registers and cost reports elsewhere (payroll.routes.js).
 *
 *   GET /runs                     pay-run selector (for register/statutory tabs)
 *   GET /runs/:id/register        payroll register (per-employee + column totals)
 *   GET /runs/:id/statutory       statutory summary (PF/ESI/PT/TDS | PAYE/KS/ESCT/ACC)
 *   GET /headcount                headcount & attrition by department/entity
 *   GET /leave-liability          outstanding leave balances valued
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('./reports.controller');

router.use(protect);
router.use(requirePermission('canViewPayrollReports'));

router.get('/runs', c.listRuns);
router.get('/runs/:id/register', c.payrollRegister);
router.get('/runs/:id/statutory', c.statutorySummary);
router.get('/headcount', c.headcount);
router.get('/leave-liability', c.leaveLiability);

module.exports = router;
