'use strict';
// Attendance & time routes. Mounted by the lead at /api/hr/attendance.
// All routes require an authenticated operator (router.use(protect)); mutations
// are gated by the canManageAttendance permission. Punches are self/manager
// actions so they only require view-level access; approvals require management.
// Every employee-facing route attaches withEmployeeScope(...) so reads/writes are
// filtered to the actor's reporting sub-tree (Feature 1) and out-of-scope single
// targets resolve to 404 (IDOR-safe), never 403.
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');
const c = require('../controllers/attendance.controller');

router.use(protect);
router.use(attachSelfEmployee); // Feature 1: hierarchy anchor (req.user.employeeId)

/* Holidays — calendar CRUD + statutory import (own controller, mounted here). */
router.use('/holidays', require('./holidays.routes'));

/* FLAG (Feature 29 — shared edit): shift management (roster grid + rotation +
   shift-swap manager queue). Mounted here so /attendance/roster|rotations|swaps
   inherit protect + attachSelfEmployee; the sub-router adds F1 scope + RBAC. */
router.use('/', require('./roster.routes'));

/* Punches — clock in/out. Recording a punch is a self/manager action scoped to the
   sub-tree; an out-of-scope target → 404, a punch into a locked day → 409. On
   success the affected (employee, day) is re-derived. */
router.post('/punch', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.createPunch);
router.get('/punches', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.listPunches);
router.post('/punches/import', requirePermission('canManageAttendance'), withEmployeeScope('canManageAttendance'), c.importPunches);

/* Dashboard summary + idempotent recompute. */
router.get('/summary', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.summary);
router.post('/recompute', requirePermission('canManageAttendance'), withEmployeeScope('canManageAttendance'), c.recomputeRange);

/* Period close — bulk lock of the Attendance rollup for a scoped range. */
router.post('/period/close', requirePermission('canManageAttendance'), withEmployeeScope('canManageAttendance'), c.closePeriod);

/* Shift patterns ("shifts") — read open to any operator, writes managed. */
router.get('/shifts', c.listShifts);
router.get('/shifts/:id', c.getShift);
router.post('/shifts', requirePermission('canManageAttendance'), c.createShift);
router.patch('/shifts/:id', requirePermission('canManageAttendance'), c.updateShift);
router.delete('/shifts/:id', requirePermission('canManageAttendance'), c.removeShift);

/* Shift assignment (emp -> pattern, effective-dated). Overlap → 409. */
router.post('/shifts/:id/assign', requirePermission('canManageAttendance'), withEmployeeScope('canManageAttendance'), c.assignShift);
router.get('/assignments', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.listAssignments);
router.delete('/assignments/:id', requirePermission('canManageAttendance'), withEmployeeScope('canManageAttendance'), c.removeAssignment);

/* Timesheets — read + state transitions. Submit is a self/manager action (the
   owning employee may submit their own); approve/reject/lock require management. */
router.get('/timesheets', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.listTimesheets);
router.get('/timesheets/:id', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.getTimesheet);
router.post('/timesheets/:id/submit', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.submitTimesheet);
router.post('/timesheets/:id/approve', requirePermission('canManageAttendance'), c.approveTimesheet);
router.post('/timesheets/:id/reject', requirePermission('canManageAttendance'), c.rejectTimesheet);
router.post('/timesheets/:id/lock', requirePermission('canManageAttendance'), c.lockTimesheet);

/* Frozen payroll feed — READ ONLY (no create/update/delete by design). Scoped to
   the actor's reporting sub-tree (H1): an out-of-scope/forged employeeId → empty. */
router.get('/pay-inputs', requirePermission('canViewPayrollReports'), withEmployeeScope('canViewPayrollReports'), c.listPayInputs);

/* Regularization (AttendanceRegularizationRequest). Self-create allowed; reads
   filter to the sub-tree; approve/reject are management-gated and 404 on an
   out-of-scope target employee (the :id is a request id, not an employeeId, so the
   per-target check lives in the controller). Approve materializes manual punches
   + re-derives the day. */
router.post('/regularizations', requirePermission('canViewEmployees'), withEmployeeScope('canManageAttendance'), c.createRegularization);
router.get('/regularizations', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.listRegularizations);
// H2 (SoD) — approve/reject scope on the APPROVAL action 'canApproveRegularization'
// so the resolver excludes SELF: a filer can never approve their OWN request.
router.post('/regularizations/:id/approve', requirePermission('canManageAttendance'), withEmployeeScope('canApproveRegularization'), c.approveRegularization);
router.post('/regularizations/:id/reject', requirePermission('canManageAttendance'), withEmployeeScope('canApproveRegularization'), c.rejectRegularization);

module.exports = router;
