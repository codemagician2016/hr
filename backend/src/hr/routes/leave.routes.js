'use strict';
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/leave.controller');

// All leave routes require an authenticated operator. Reading config + balances
// is open to any operator; config writes need canManageOrg; request decisions
// (approve/reject) need canApproveLeave.
router.use(protect);

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
router.get('/requests', c.listRequests);
router.get('/requests/:id', c.getRequest);
router.post('/requests', c.createRequest);
router.post('/requests/:id/approve', requirePermission('canApproveLeave'), c.approveRequest);
router.post('/requests/:id/reject', requirePermission('canApproveLeave'), c.rejectRequest);
router.post('/requests/:id/cancel', c.cancelRequest);

// ── (c) Employee leave balances ─────────────────────────────────────────────
router.get('/employees/:employeeId/balances', c.listEmployeeBalances);

module.exports = router;
