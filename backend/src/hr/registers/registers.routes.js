'use strict';

/**
 * registers.routes.js — Statutory Registers API (Feature 32), mounted at
 * /api/hr/registers by hr/routes/index.js.
 *
 * READ-ONLY projection over already-frozen data (attendance freeze + payroll
 * snapshot + leave ledger). India-only (the controller asserts entity.countryCode
 * === 'IN'). No source table is written.
 *
 * RBAC (reuses the existing catalog — NO new permission):
 *   read + export  (catalog / preview / export / exports history) → canViewPayrollReports
 *   definitions    (list / create / patch / seed)                 → canManageStatutory
 *
 * Middleware chain mirrors reports.routes.js: protect (req.user.businessId) →
 * requirePermission → attachSelfEmployee + withEmployeeScope so a Manager's
 * register is data-scoped to their reporting sub-tree (F1). Every handler is
 * businessId-scoped; :id lookups use findFirst({ id, businessId }) so cross-tenant
 * access 404s.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');
const c = require('./registers.controller');

router.use(protect);

// ── Read + export (canViewPayrollReports) — data-scoped to the actor's sub-tree ─
router.get(
  '/catalog',
  requirePermission('canViewPayrollReports'),
  attachSelfEmployee,
  withEmployeeScope('canViewPayrollReports'),
  c.catalog
);
router.get(
  '/preview',
  requirePermission('canViewPayrollReports'),
  attachSelfEmployee,
  withEmployeeScope('canViewPayrollReports'),
  c.preview
);
router.get(
  '/export',
  requirePermission('canViewPayrollReports'),
  attachSelfEmployee,
  withEmployeeScope('canViewPayrollReports'),
  c.exportRegister
);
router.get(
  '/exports',
  requirePermission('canViewPayrollReports'),
  attachSelfEmployee,
  withEmployeeScope('canViewPayrollReports'),
  c.listExports
);

// ── Definition management (canManageStatutory; SoD — never canRunPayroll) ──────
router.get('/definitions', requirePermission('canManageStatutory'), c.listDefinitions);
router.post('/definitions', requirePermission('canManageStatutory'), c.createDefinition);
router.patch('/definitions/:id', requirePermission('canManageStatutory'), c.updateDefinition);
router.post('/definitions/seed', requirePermission('canManageStatutory'), c.seedDefinitions);

module.exports = router;
