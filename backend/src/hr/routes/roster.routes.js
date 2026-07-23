'use strict';

/**
 * roster.routes.js — Feature 29 (shift management) hr-admin operator routes, mounted
 * under /api/hr/attendance (so /attendance/roster|rotations|swaps). The parent
 * attendance router already applies protect + attachSelfEmployee; here we add the F1
 * sub-tree scope (withEmployeeScope) and the RBAC permission per route, mirroring the
 * attendance regularization surface. Reads = canViewEmployees; writes/decisions =
 * canManageAttendance (+ canApproveRegularization for swap decisions).
 */

const express = require('express');

const router = express.Router();
const { requirePermission } = require('../../core/middleware/auth.middleware');
const { withEmployeeScope } = require('../middleware/scope.middleware');
const c = require('../controllers/roster.controller');

/* Roster grid + cells. */
router.get('/roster/grid', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.rosterGrid);
router.get('/roster/days', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.rosterDays);
router.put('/roster/cell', requirePermission('canManageAttendance'), withEmployeeScope('canManageAttendance'), c.upsertCell);
router.post('/roster/bulk', requirePermission('canManageAttendance'), withEmployeeScope('canManageAttendance'), c.bulkUpsert);
router.post('/roster/publish', requirePermission('canManageAttendance'), withEmployeeScope('canManageAttendance'), c.publish);

/* Rotation templates. */
router.get('/rotations', requirePermission('canViewEmployees'), c.listRotations);
router.post('/rotations', requirePermission('canManageAttendance'), c.createRotation);
router.patch('/rotations/:id', requirePermission('canManageAttendance'), c.updateRotation);
router.delete('/rotations/:id', requirePermission('canManageAttendance'), c.removeRotation);
router.post('/rotations/:id/apply', requirePermission('canManageAttendance'), withEmployeeScope('canManageAttendance'), c.applyRotation);

/* Shift-swap manager queue + F10 decision. */
router.get('/swaps', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.listSwaps);
router.post('/swaps/:id/approve', requirePermission('canManageAttendance'), withEmployeeScope('canApproveRegularization'), c.approveSwap);
router.post('/swaps/:id/reject', requirePermission('canManageAttendance'), withEmployeeScope('canApproveRegularization'), c.rejectSwap);

/* Open shifts — publish an unassigned shift to a claim pool; employees claim via ESS
   (/me/shifts/open) and the roster manager confirms through the F10 OPEN_SHIFT_CLAIM
   inbox. Reads = canViewEmployees; publish/cancel = canManageAttendance. */
router.get('/open-shifts', requirePermission('canViewEmployees'), c.listOpenShifts);
router.get('/open-shifts/:id', requirePermission('canViewEmployees'), c.getOpenShift);
router.post('/open-shifts', requirePermission('canManageAttendance'), c.createOpenShift);
router.post('/open-shifts/:id/cancel', requirePermission('canManageAttendance'), c.cancelOpenShift);

module.exports = router;
