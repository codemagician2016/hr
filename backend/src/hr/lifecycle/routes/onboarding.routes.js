'use strict';

/**
 * onboarding.routes.js — onboarding pipeline + task action routes (Feature 4
 * §4.6, slice 4a). Mounted at /api/hr/onboarding by the HR route aggregator.
 *
 * Every route runs `protect` + `attachSelfEmployee` (the F1 hierarchy anchor),
 * then per-route `requirePermission(...)` + `withEmployeeScope(action, {idParam})`
 * so reads/writes are filtered to the actor's reporting sub-tree and out-of-scope
 * single targets resolve to 404 (IDOR-safe).
 *
 * RBAC posture (§4.5):
 *   - Pipeline reads / advance         → canViewEmployees scope (HR=ALL, Manager=TEAM)
 *   - Task complete/skip               → canViewEmployees scope; the controller
 *                                        further requires the manager to OWN the task
 *   - (template config / provision land in 4a-later/4c; not in this router yet)
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../../middleware/scope.middleware');
const c = require('../controllers/onboarding.controller');

router.use(protect);
router.use(attachSelfEmployee); // Feature 1 hierarchy anchor (req.user.employeeId)

// ── Pipeline board ───────────────────────────────────────────────────────────
router.get('/journeys',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees'),
  c.listJourneys);

router.get('/journeys/:id',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees'),
  c.getJourney);

// Re-run the engine + persist (HR pipeline action). Out-of-scope :id → 404.
router.post('/journeys/:id/advance',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees', { idParam: 'id' }),
  c.advanceJourney);

// ── Tasks ────────────────────────────────────────────────────────────────────
// owner=me → the actor's own tasks; owner=all → the in-scope sub-tree's tasks.
router.get('/tasks',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees'),
  c.listTasks);

// Complete / skip a task. Scope is enforced in the controller via the task's
// subject employee + owner check (a manager completes only manager-owned tasks
// for their reports); out-of-scope → 404.
router.post('/tasks/:id/complete',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees'),
  c.completeTask);

router.post('/tasks/:id/skip',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees'),
  c.skipTask);

module.exports = router;
