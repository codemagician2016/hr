'use strict';

/**
 * offboarding.routes.js — separation + Full-and-Final settlement routes
 * (Feature 4 §4.6, slice 4f). Mounted at /api/hr/separations by the HR aggregator.
 *
 * Every route runs `protect` + `attachSelfEmployee` (the F1 hierarchy anchor),
 * then per-route `requirePermission(...)` + `withEmployeeScope(action)` so
 * reads/writes are filtered to the actor's reporting sub-tree and out-of-scope
 * single targets resolve to 404 (IDOR-safe). The path :id is a SEPARATION id, not
 * an Employee id, so we do NOT pass { idParam } — the controller's loadScopedCase
 * resolves the case's SUBJECT employee and 404s out-of-scope.
 *
 * RBAC posture (§4.5):
 *   - initiate / compute-fnf / settle / cancel → canRunSeparation (HR-Admin = ALL)
 *   - clearance lanes                          → canViewEmployees scope; the
 *     controller enforces per-lane ownership (a manager clears only KT + assets)
 *   - approve-fnf                              → canApprovePayroll (APPROVAL_ACTIONS
 *     strips self) + the controller's explicit initiator ≠ approver SoD guard
 *   - letters                                  → canGenerateLetters (gated on SETTLED)
 *   - reads (list/get)                         → canViewEmployees scope
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../../middleware/scope.middleware');
const c = require('../controllers/offboarding.controller');

router.use(protect);
router.use(attachSelfEmployee); // Feature 1 hierarchy anchor (req.user.employeeId)

// ── Reads (scoped: HR=ALL, Manager=their departing reports) ─────────────────
router.get('/',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees'),
  c.listSeparations);

router.get('/:id',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees'),
  c.getSeparation);

// ── Initiate (HR: canRunSeparation) ─────────────────────────────────────────
router.post('/',
  requirePermission('canRunSeparation'),
  withEmployeeScope('canRunSeparation'),
  c.initiateSeparation);

// ── Clearance lanes (scoped; per-lane ownership enforced in the controller) ──
// A manager may clear ONLY the KT + asset-return lanes for their reports.
router.patch('/:id/clearance',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees'),
  c.updateClearance);

// ── Compute FnF (HR: canRunSeparation) — blocked while clearance/assets open ─
router.post('/:id/compute-fnf',
  requirePermission('canRunSeparation'),
  withEmployeeScope('canRunSeparation'),
  c.computeFnf);

// ── Approve FnF (SoD: canApprovePayroll + initiator ≠ approver) ──────────────
router.post('/:id/approve-fnf',
  requirePermission('canApprovePayroll'),
  withEmployeeScope('canApprovePayroll'),
  c.approveFnf);

// ── Settle (HR: canRunSeparation) — revoke access + end-date the employee ────
router.post('/:id/settle',
  requirePermission('canRunSeparation'),
  withEmployeeScope('canRunSeparation'),
  c.settleSeparation);

// ── Cancel / withdraw a pre-SETTLE case ─────────────────────────────────────
router.post('/:id/cancel',
  requirePermission('canRunSeparation'),
  withEmployeeScope('canRunSeparation'),
  c.cancelSeparation);

// ── Letters (canGenerateLetters; gated on SETTLED) ──────────────────────────
router.post('/:id/letters',
  requirePermission('canGenerateLetters'),
  withEmployeeScope('canGenerateLetters'),
  c.generateLetters);

module.exports = router;
