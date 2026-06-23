'use strict';

/**
 * profile.routes.js — Feature 13 HR-admin profile surface, mounted at
 * /api/hr/profile (operator session). Three areas:
 *   - the field-policy map (config view)               → canViewEmployees
 *   - the profile change-request approval queue        → canManageEmployees, F1-scoped
 *   - the rich sectioned profile for any in-scope emp  → canViewEmployees, F1-scoped
 *
 * The change-request approve/reject drive the F10 engine (SoD/version intact) + the
 * extra "operator ≠ own linked employee" guard. The queue + the rich read are
 * employee-scoped (withEmployeeScope) so a Manager only sees their sub-tree.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');
const admin = require('../profile/profileAdmin.controller');
const queue = require('../profile/profileChangeAdmin.controller');

router.use(protect);
router.use(attachSelfEmployee); // hierarchy anchor (req.user.employeeId) for scope + SoD

// ── field-policy map (config / display) ──
router.get('/policy', requirePermission('canViewEmployees'), admin.getPolicy);

// ── change-request approval queue (scoped to the operator's sub-tree) ──
router.get('/change-requests', requirePermission('canManageEmployees'), withEmployeeScope('canViewEmployees'), queue.list);
router.post('/change-requests/:id/approve', requirePermission('canManageEmployees'), withEmployeeScope('canViewEmployees'), queue.approve);
router.post('/change-requests/:id/reject', requirePermission('canManageEmployees'), withEmployeeScope('canViewEmployees'), queue.reject);

// ── rich sectioned profile for any in-scope employee ──
router.get('/employees/:id/full', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees', { idParam: 'id' }), admin.getEmployeeFull);

module.exports = router;
