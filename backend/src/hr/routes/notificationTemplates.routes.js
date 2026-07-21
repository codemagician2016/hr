'use strict';

/**
 * notificationTemplates.routes.js — Program P1.6: tenant notification template
 * overrides. Mounted at /api/hr/notifications. Org-level config → canManageOrg.
 */

const express = require('express');
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../notifications/templates.controller');

const router = express.Router();
router.use(protect);

router.get('/templates', requirePermission('canManageOrg'), c.list);
router.put('/templates/:key', requirePermission('canManageOrg'), c.upsert);
router.delete('/templates/:key', requirePermission('canManageOrg'), c.reset);
router.post('/templates/:key/preview', requirePermission('canManageOrg'), c.preview);

module.exports = router;
