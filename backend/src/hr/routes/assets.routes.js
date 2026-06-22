'use strict';
// Asset register + assignment lifecycle routes. Reads are open to any operator
// who can view employees; mutations (register edits, assign, return) require
// canManageEmployees. Tenant scoping is enforced in the controller by
// req.user.businessId. Mounted at /api/hr/assets by the HR route aggregator.
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/assets.controller');

router.use(protect);

// ── Assignment lifecycle ─────────────────────────────────────────────────────
// Declared before the `/:id` asset routes so the literal `/assignments` segment
// is matched ahead of the asset-id wildcard.
router.get('/assignments', requirePermission('canViewEmployees'), c.listAssignments);
router.get('/assignments/:id', requirePermission('canViewEmployees'), c.getAssignment);
router.post('/assignments', requirePermission('canManageEmployees'), c.assign);
router.post('/assignments/:id/return', requirePermission('canManageEmployees'), c.returnAsset);

// ── Asset register ───────────────────────────────────────────────────────────
router.get('/', requirePermission('canViewEmployees'), c.listAssets);
router.get('/:id', requirePermission('canViewEmployees'), c.getAsset);
router.post('/', requirePermission('canManageEmployees'), c.createAsset);
router.patch('/:id', requirePermission('canManageEmployees'), c.updateAsset);
router.delete('/:id', requirePermission('canManageEmployees'), c.removeAsset);

module.exports = router;
