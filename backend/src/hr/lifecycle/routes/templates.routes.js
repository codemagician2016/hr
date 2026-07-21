'use strict';

/**
 * templates.routes.js — Program P1.4: lifecycle template authoring + probation
 * policy. Mounted at /api/hr/lifecycle. RBAC mirrors the onboarding console
 * (canManageOnboarding) — template/probation authoring is the same HR surface.
 */

const express = require('express');
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const templates = require('../controllers/templates.controller');
const probation = require('../controllers/probation.controller');

const router = express.Router();
router.use(protect);

// ── lifecycle templates ──
router.get('/templates/meta', requirePermission('canManageOnboarding'), templates.meta);
router.get('/templates', requirePermission('canManageOnboarding'), templates.list);
router.get('/templates/:id', requirePermission('canManageOnboarding'), templates.get);
router.post('/templates', requirePermission('canManageOnboarding'), templates.create);
router.post('/templates/seed-defaults', requirePermission('canManageOnboarding'), templates.seedDefaults);
router.patch('/templates/:id', requirePermission('canManageOnboarding'), templates.update);
router.put('/templates/:id/tasks', requirePermission('canManageOnboarding'), templates.replaceTasks);
router.delete('/templates/:id', requirePermission('canManageOnboarding'), templates.remove);

// ── probation policies ──
router.get('/probation-policies', requirePermission('canManageOnboarding'), probation.list);
router.post('/probation-policies', requirePermission('canManageOnboarding'), probation.create);
router.patch('/probation-policies/:id', requirePermission('canManageOnboarding'), probation.update);
router.delete('/probation-policies/:id', requirePermission('canManageOnboarding'), probation.remove);

module.exports = router;
