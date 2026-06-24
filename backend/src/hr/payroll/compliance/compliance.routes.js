'use strict';

/**
 * compliance.routes.js — Statutory Compliance Calendar API (Feature 23), mounted
 * at /api/hr/compliance by hr/routes/index.js.
 *
 * RBAC (reuses the existing catalog — no new permission):
 *   read  (calendar / detail / obligations list) → canViewPayrollReports
 *   write (mark-filed / proof / waive / obligations / seed / sweep) → canManageStatutory
 *
 * `protect` runs first so req.user.businessId is populated for tenant scoping +
 * the per-tenant rate-limit key. Every handler is businessId-scoped; :id lookups
 * use findFirst({ id, businessId }) so cross-tenant access 404s.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const { payrollMutationLimiter } = require('../../../core/middleware/abuse.middleware');
const c = require('./compliance.controller');

router.use(protect);

// ── Read (finance/HR can see the calendar) ──
router.get('/calendar', requirePermission('canViewPayrollReports'), c.getCalendar);
router.get('/calendar/:remittanceId', requirePermission('canViewPayrollReports'), c.getRemittanceDetail);
router.get('/obligations', requirePermission('canViewPayrollReports'), c.listObligations);

// ── Mutations (canManageStatutory; SoD — never inferred from canRunPayroll) ──
router.post('/remittances/:id/mark-filed', payrollMutationLimiter, requirePermission('canManageStatutory'), c.markFiled);
router.post('/remittances/:id/proof', payrollMutationLimiter, requirePermission('canManageStatutory'), c.uploadProof);
router.post('/remittances/:id/waive', payrollMutationLimiter, requirePermission('canManageStatutory'), c.waive);

router.post('/obligations', requirePermission('canManageStatutory'), c.createObligation);
router.patch('/obligations/:id', requirePermission('canManageStatutory'), c.updateObligation);
router.post('/obligations/seed', requirePermission('canManageStatutory'), c.seedObligations);

// ── Admin/debug: manual generate+sweep+remind (the same fns the cron calls) ──
router.post('/sweep', requirePermission('canManageStatutory'), c.manualSweep);

module.exports = router;
