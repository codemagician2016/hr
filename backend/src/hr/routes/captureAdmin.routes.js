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
const fences = require('../attendance/capture/fenceAdmin.controller');
const enroll = require('../attendance/capture/enrollmentAdmin.controller');

// Capture policies (per-tenant / per-scope mode policy: geo/IP/face).
router.get('/policies', requirePermission('canViewEmployees'), c.listPolicies);
router.post('/policies', requirePermission('canManageAttendance'), c.upsertPolicy);
router.delete('/policies/:id', requirePermission('canManageAttendance'), c.deletePolicy);

// Office IP allow-list (CIDRs) per location (IP_RESTRICTED mode).
router.get('/locations/:locationId/ips', requirePermission('canViewEmployees'), c.listLocationIps);
router.post('/locations/:locationId/ips', requirePermission('canManageAttendance'), c.addLocationIp);
router.delete('/locations/:locationId/ips/:id', requirePermission('canManageAttendance'), c.deleteLocationIp);

// Feature 39 — polygon geofences + links (office zones / individual restriction).
router.get('/fences', requirePermission('canViewEmployees'), fences.listFences);
router.post('/fences', requirePermission('canManageAttendance'), fences.upsertFence);
router.delete('/fences/:id', requirePermission('canManageAttendance'), fences.deleteFence);
router.post('/fences/:id/links', requirePermission('canManageAttendance'), fences.addFenceLink);
router.delete('/fences/:id/links/:linkId', requirePermission('canManageAttendance'), fences.deleteFenceLink);
router.get('/employees/:employeeId/zones', requirePermission('canViewEmployees'), fences.employeeZones);

// Feature 39 — face registration register (PENDING queue / ACTIVE roster) + actions.
router.get('/enrollments', requirePermission('canManageAttendance'), enroll.listEnrollments);
router.post('/enrollments', requirePermission('canManageAttendance'), enroll.hrEnroll);
router.post('/enrollments/:id/decide', requirePermission('canManageAttendance'), enroll.decideEnrollment);
router.post('/enrollments/:id/revoke', requirePermission('canManageAttendance'), enroll.revokeEnrollment);

// Flagged-punch review queue (off-network / low face score / needs-review).
router.get('/review', requirePermission('canManageAttendance'), c.listReviewQueue);
router.post('/review/:id', requirePermission('canManageAttendance'), c.actOnReview);

module.exports = router;
