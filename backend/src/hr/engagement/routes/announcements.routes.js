'use strict';

/**
 * announcements.routes.js — operator authoring API for the company news feed,
 * mounted at /api/hr/announcements. OPERATOR session; every route is gated on
 * canManageAnnouncements (Owner + HR-Admin). Tenant-scoped in the controller.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/announcementsAdmin.controller');

router.use(protect);

const gate = requirePermission('canManageAnnouncements');

// Reads
router.get('/', gate, c.list);
router.get('/:id', gate, c.get);

// Writes
router.post('/', gate, c.create);
router.patch('/:id', gate, c.update);
router.delete('/:id', gate, c.remove);

// Lifecycle + presentation
router.post('/:id/publish', gate, c.publish);
router.post('/:id/archive', gate, c.archive);
router.post('/:id/pin', gate, c.pin);
router.post('/:id/unpin', gate, c.unpin);

module.exports = router;
