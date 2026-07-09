'use strict';

/**
 * templates.routes.js — Letter template library (Feature 9, slice 9D). Mounted at
 * /api/hr/letters/templates (see backend/src/hr/routes/index.js).
 *
 * Templates are tenant CONFIG, not per-employee data: every route requires an
 * authenticated operator (`protect`) + the config key `canManageLetters`
 * (`requirePermission`). There is NO employee scope here — these endpoints are
 * tenant-level and the controller scopes every query by `req.user.businessId`
 * (cross-tenant id ⇒ 404).
 *
 * `/merge-fields` (the §7 palette for the editor inserter) is registered BEFORE
 * `/:id` so the literal path is not captured by the `:id` param route.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/templates.controller');

router.use(protect);
router.use(requirePermission('canManageLetters'));

// Merge-field palette (literal path — MUST precede /:id).
router.get('/merge-fields', c.listMergeFields);

router.get('/', c.listTemplates);
router.post('/', c.createTemplate);

router.get('/:id', c.getTemplate);
router.put('/:id', c.updateTemplate);
router.post('/:id/publish', c.publishTemplate);
router.post('/:id/archive', c.archiveTemplate);
// Static signature image (auto-stamped on every issued letter for this template).
router.post('/:id/signature', c.uploadSignature);
router.delete('/:id/signature', c.deleteSignature);
router.delete('/:id', c.deleteTemplate);

module.exports = router;
