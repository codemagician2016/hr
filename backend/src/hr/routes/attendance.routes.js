'use strict';
// Attendance & time routes. Mounted by the lead at /api/hr/attendance.
// All routes require an authenticated operator (router.use(protect)); mutations
// are gated by the canManageAttendance permission. Punches are self/manager
// actions so they only require view-level access; approvals require management.
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');
const c = require('../controllers/attendance.controller');

router.use(protect);
router.use(attachSelfEmployee); // Feature 1: hierarchy anchor (req.user.employeeId)

/* Punches — clock in/out. Recording a punch is a routine operator action;
   reading the log needs at least employee-view access (filtered to sub-tree). */
router.post('/punch', requirePermission('canViewEmployees'), c.createPunch);
router.get('/punches', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.listPunches);

/* Shift patterns ("shifts") — read open to any operator, writes managed. */
router.get('/shifts', c.listShifts);
router.get('/shifts/:id', c.getShift);
router.post('/shifts', requirePermission('canManageAttendance'), c.createShift);
router.patch('/shifts/:id', requirePermission('canManageAttendance'), c.updateShift);
router.delete('/shifts/:id', requirePermission('canManageAttendance'), c.removeShift);

/* Shift assignment (emp -> pattern, effective-dated). */
router.post('/shifts/:id/assign', requirePermission('canManageAttendance'), c.assignShift);
router.get('/assignments', withEmployeeScope('canViewEmployees'), c.listAssignments);
router.delete('/assignments/:id', requirePermission('canManageAttendance'), c.removeAssignment);

/* Timesheets — read + state transitions. Submit is an operator/self action;
   approve/reject/lock require management. */
router.get('/timesheets', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.listTimesheets);
router.get('/timesheets/:id', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.getTimesheet);
router.post('/timesheets/:id/submit', requirePermission('canManageAttendance'), c.submitTimesheet);
router.post('/timesheets/:id/approve', requirePermission('canManageAttendance'), c.approveTimesheet);
router.post('/timesheets/:id/reject', requirePermission('canManageAttendance'), c.rejectTimesheet);
router.post('/timesheets/:id/lock', requirePermission('canManageAttendance'), c.lockTimesheet);

/* Frozen payroll feed — READ ONLY (no create/update/delete by design). */
router.get('/pay-inputs', requirePermission('canViewPayrollReports'), c.listPayInputs);

/* Regularization (manual-punch request + approve). Reads filter to the sub-tree;
   the create + decisions resolve the canManageAttendance scope and the controller
   404s when the target employee is out of scope (the :requestId is a group id, not
   an employeeId, so the per-target check lives in the controller). */
router.post('/regularizations', requirePermission('canViewEmployees'), withEmployeeScope('canManageAttendance'), c.createRegularization);
router.get('/regularizations', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.listRegularizations);
router.post('/regularizations/:requestId/approve', requirePermission('canManageAttendance'), withEmployeeScope('canManageAttendance'), c.approveRegularization);
router.post('/regularizations/:requestId/reject', requirePermission('canManageAttendance'), withEmployeeScope('canManageAttendance'), c.rejectRegularization);

module.exports = router;
