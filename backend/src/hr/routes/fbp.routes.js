'use strict';

/**
 * fbp.routes.js — Feature 25. The OPERATOR (hr-admin) FBP routes, mounted at
 * /api/hr/fbp. Operator session + the F1 hierarchy anchor. RBAC:
 *   - plan authoring shapes pay structure (like F17 policies, no person money) →
 *     canViewCompensation (read) / canManageCompensation (write).
 *   - allocation roster reads = canViewEmployees, F1-scoped (req.scope filters).
 *   - force-lock moves TDS → canManagePayroll, SoD operator ≠ subject (in controller).
 * Proof verify for FBP bills reuses the F20 /api/hr/proofs console verbatim.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');
const c = require('../controllers/fbp.controller');

router.use(protect);
router.use(attachSelfEmployee);

// ── Plan builder (Compensation) ──────────────────────────────────────────────
router.get('/plans', requirePermission('canViewCompensation'), c.listPlans);
router.get('/plans/template', requirePermission('canViewCompensation'), c.getTemplate);
router.get('/plans/:id', requirePermission('canViewCompensation'), c.getPlan);
router.post('/plans', requirePermission('canManageCompensation'), c.createPlan);
router.patch('/plans/:id', requirePermission('canManageCompensation'), c.updatePlan);
router.delete('/plans/:id', requirePermission('canManageCompensation'), c.deletePlan);
router.post('/plans/:id/preview', requirePermission('canViewCompensation'), c.previewPlan);

// ── Allocation roster + drill-down (Employees, F1-scoped) ────────────────────
router.get('/allocations',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees'),
  c.listAllocations);

router.get('/employees/:employeeId/fbp',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees', { idParam: 'employeeId' }),
  c.getEmployeeFbp);

router.post('/employees/:employeeId/fbp/:id/lock',
  requirePermission('canManagePayroll'),
  withEmployeeScope('canManagePayroll', { idParam: 'employeeId' }),
  c.lockEmployeeFbp);

module.exports = router;
