'use strict';

/**
 * regimeAdmin.routes.js — Feature 15/25. The HR income-tax REGIME console, mounted at
 * /api/hr/tax (so /tax/regime-policy + /tax/regime + /tax/regime/lock). Operator session
 * + the F1 hierarchy anchor. RBAC mirrors the declaration-window:
 *   read  (policy + per-employee list) → canViewPayrollReports
 *   write (set policy / lock / unlock / elect) → canManageStatutory
 * The per-employee list is F1-SCOPED (attachSelfEmployee + withEmployeeScope) so a
 * manager only sees their team (IDOR-safe). Cross-tenant ids resolve to 404 in the service.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');
const c = require('../tax/regime/regimeAdmin.controller');

router.use(protect);
router.use(attachSelfEmployee);

// Per-FY policy (employer default + election window + global lock).
router.get('/regime-policy', requirePermission('canViewPayrollReports'), c.getPolicy);
router.put('/regime-policy', requirePermission('canManageStatutory'), c.putPolicy);

// Per-employee regime view (PAGINATED, searchable, F1-scoped).
router.get('/regime',
  requirePermission('canViewPayrollReports'),
  withEmployeeScope('canViewEmployees'),
  c.listEmployeeRegimes);

// Lock / unlock / HR-elect (write — statutory gate).
router.post('/regime/lock', requirePermission('canManageStatutory'), c.lock);
router.post('/regime/unlock', requirePermission('canManageStatutory'), c.unlock);
router.post('/regime/elect', requirePermission('canManageStatutory'), c.electForEmployee);

module.exports = router;
