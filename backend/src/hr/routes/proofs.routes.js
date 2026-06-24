'use strict';

/**
 * proofs.routes.js — Feature 20 slice 20c. The HR proof-VERIFICATION console, mounted
 * at /api/hr/proofs. Operator session + the F1 hierarchy anchor. RBAC: reading =
 * canViewEmployees; accept/reject = canManageEmployees (same gate as verifyDocument).
 * Per-employee routes are F1-SCOPED via withEmployeeScope(action,{idParam}), so a
 * manager hitting an out-of-team employee resolves to 404 (IDOR-safe). The queue route
 * attaches req.scope (no idParam) so the controller filters to the team's proofs.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');
const c = require('../tax/investmentProof/proofs.controller');

router.use(protect);
router.use(attachSelfEmployee);

// Tenant/team verify queue (attach req.scope so the controller can filter to the team).
router.get('/',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees'),
  c.listProofQueue);

// Per-employee drill-down + verdicts (F1-scoped on :employeeId — IDOR→404).
router.get('/employees/:employeeId/proofs',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees', { idParam: 'employeeId' }),
  c.listEmployeeProofs);

router.get('/employees/:employeeId/proofs/:id/file',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees', { idParam: 'employeeId' }),
  c.getProofFile);

router.post('/employees/:employeeId/proofs/:id/accept',
  requirePermission('canManageEmployees'),
  withEmployeeScope('canManageEmployees', { idParam: 'employeeId' }),
  c.acceptProof);

router.post('/employees/:employeeId/proofs/:id/reject',
  requirePermission('canManageEmployees'),
  withEmployeeScope('canManageEmployees', { idParam: 'employeeId' }),
  c.rejectProof);

module.exports = router;
