'use strict';

/**
 * captureAdmin.routes.js — HR-admin Attendance Capture Policy routes. Mounted by
 * attendance.routes.js at /api/hr/attendance/capture, so these inherit `protect`
 * (operator session) + attachSelfEmployee from the parent. Reads require view-level
 * access; every mutation + the review queue require canManageAttendance (the
 * HR-admin "manage attendance" permission).
 */

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../attendance/capture/captureAdmin.controller');

// Capture policies (per-tenant / per-scope mode policy: geo/IP/face).
router.get('/policies', requirePermission('canViewEmployees'), c.listPolicies);
router.post('/policies', requirePermission('canManageAttendance'), c.upsertPolicy);
router.delete('/policies/:id', requirePermission('canManageAttendance'), c.deletePolicy);

// Office IP allow-list (CIDRs) per location (IP_RESTRICTED mode).
router.get('/locations/:locationId/ips', requirePermission('canViewEmployees'), c.listLocationIps);
router.post('/locations/:locationId/ips', requirePermission('canManageAttendance'), c.addLocationIp);
router.delete('/locations/:locationId/ips/:id', requirePermission('canManageAttendance'), c.deleteLocationIp);

// Flagged-punch review queue (off-network / low face score / needs-review).
router.get('/review', requirePermission('canManageAttendance'), c.listReviewQueue);
router.post('/review/:id', requirePermission('canManageAttendance'), c.actOnReview);

module.exports = router;
