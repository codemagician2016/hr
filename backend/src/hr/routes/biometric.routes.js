'use strict';

/**
 * biometric.routes.js — Feature 28 operator API, mounted at /api/hr/biometric (see
 * the FLAG in src/hr/routes/index.js). The DEVICE-FACING push ingest door
 * (POST /api/hr/biometric/ingest/:deviceSerial) is NOT here — it is device-secret-
 * authed and mounted at app root BEFORE express.json() (see src/index.js).
 *
 * RBAC: every route is canManageAttendance-gated (devices + mapping + triage +
 * manual correction are an attendance concern; HR-Admin + Owner have it). The
 * file-import door reuses the F18 /api/hr/imports endpoints with kind=BIOMETRIC
 * (canManageImports) — it is not duplicated here.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../attendance/biometric/devices.controller');

router.use(protect);
const gate = requirePermission('canManageAttendance');

// Form metadata (vendors / adapters / direction modes).
router.get('/meta', gate, c.meta);

// Device registry.
router.get('/devices', gate, c.listDevices);
router.post('/devices', gate, c.createDevice);
router.get('/devices/:id', gate, c.getDevice);
router.patch('/devices/:id', gate, c.updateDevice);
router.delete('/devices/:id', gate, c.deleteDevice);
router.post('/devices/:id/rotate-secret', gate, c.rotateSecret);
router.get('/devices/:id/events', gate, c.listEvents);

// Raw-event triage.
router.get('/events', gate, c.listEvents);
router.get('/events/unmapped', gate, c.unmappedCodes);
router.post('/events/reprocess', gate, c.reprocess);
router.post('/events/:id/correct', gate, c.correct);

// device-code → employee mapping.
router.get('/maps', gate, c.listMaps);
router.post('/maps', gate, c.createMap);
router.post('/maps/bulk', gate, c.bulkMaps);
router.delete('/maps/:id', gate, c.deleteMap);

module.exports = router;
