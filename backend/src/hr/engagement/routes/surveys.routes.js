'use strict';

/**
 * surveys.routes.js — Feature 33 operator API for pulse surveys + eNPS, mounted at
 * /api/hr/surveys. OPERATOR session; every route is gated on canManageSurveys
 * (Owner + HR-Admin — same pair as canManageAnnouncements). Tenant-scoped in the
 * controller. Mirrors announcements.routes.js.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/surveysAdmin.controller');

router.use(protect);

const gate = requirePermission('canManageSurveys');

// Reads
router.get('/', gate, c.list);
// Results — declared BEFORE the bare /:id detail so the static sub-paths are
// unambiguous (mount-order convention from the letters routers).
router.get('/:id/results/trend', gate, c.trend);
router.get('/:id/results/segments', gate, c.segments);
router.get('/:id/results/verbatims', gate, c.verbatims);
router.get('/:id/results', gate, c.results);
router.get('/:id', gate, c.get);

// Writes
router.post('/', gate, c.create);
router.patch('/:id', gate, c.update);

// Lifecycle
router.post('/:id/publish', gate, c.publish);
router.post('/:id/close', gate, c.close);
router.post('/:id/archive', gate, c.archive);

module.exports = router;
