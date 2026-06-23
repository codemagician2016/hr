'use strict';
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');
const { validateBody } = require('../../core/lib/validate');
const { createLeaveRequestSchema, adjustBalanceSchema, carryForwardRunSchema } = require('../../core/lib/schemas/leave.schema');
const c = require('../controllers/leave.controller');

// All leave routes require an authenticated operator. Reading config + balances
// is open to any operator; config writes need canManageOrg; request decisions
// (approve/reject) need canApproveLeave.
router.use(protect);
router.use(attachSelfEmployee); // Feature 1: hierarchy anchor (req.user.employeeId)

// ── (a) Config: LeaveType + LeavePolicy ─────────────────────────────────────
function mountConfig(path, ctrl) {
  router.get(`/${path}`, ctrl.list);
  router.get(`/${path}/:id`, ctrl.get);
  router.post(`/${path}`, requirePermission('canManageOrg'), ctrl.create);
  router.patch(`/${path}/:id`, requirePermission('canManageOrg'), ctrl.update);
  router.delete(`/${path}/:id`, requirePermission('canManageOrg'), ctrl.remove);
}
mountConfig('types', c.leaveTypes);
mountConfig('policies', c.leavePolicies);

// ── (b) Leave request flow ──────────────────────────────────────────────────
// Reads are filtered to the actor's reporting sub-tree (canViewEmployees scope);
// decisions resolve the canApproveLeave scope (which excludes self — SoD) and the
// controller 404s when the applicant is out of scope. The :id here is a leave-txn
// id (not an employeeId), so the per-target check lives in the controller, not the
// middleware's idParam guard.
router.get('/requests', withEmployeeScope('canViewEmployees'), c.listRequests);
// ESS self-list — own requests only (employeeId from attachSelfEmployee; no widening).
router.get('/me/requests', c.listMyRequests);
router.get('/requests/:id', withEmployeeScope('canViewEmployees'), c.getRequest);
router.get('/requests/:id/history', withEmployeeScope('canViewEmployees'), c.requestHistory);
router.post('/requests', validateBody(createLeaveRequestSchema), c.createRequest);
router.post('/requests/:id/approve', requirePermission('canApproveLeave'), withEmployeeScope('canApproveLeave'), c.approveRequest);
router.post('/requests/:id/reject', requirePermission('canApproveLeave'), withEmployeeScope('canApproveLeave'), c.rejectRequest);
router.post('/requests/:id/cancel', c.cancelRequest);
// Post-approval withdraw: self or in-scope approver; controller blocks closed-payrun days.
router.post('/requests/:id/withdraw', withEmployeeScope('canViewEmployees'), c.withdrawRequest);

// ── (c) Leave calendar + reports (scope-filtered server-side) ────────────────
router.get('/calendar', withEmployeeScope('canViewEmployees'), c.leaveCalendar);
router.get('/reports/summary', withEmployeeScope('canViewEmployees'), c.reportsSummary);

// ── (d) Year-end run + audited balance adjust (canManageOrg) ─────────────────
router.post('/runs/carry-forward', requirePermission('canManageOrg'), validateBody(carryForwardRunSchema), c.carryForwardRun);
router.post('/balances/adjust', requirePermission('canManageOrg'), validateBody(adjustBalanceSchema), c.adjustBalance);

// ── (e) Employee leave balances ─────────────────────────────────────────────
router.get('/employees/:employeeId/balances', c.listEmployeeBalances);

module.exports = router;
