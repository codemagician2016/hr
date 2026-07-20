'use strict';

// Feature 39 — letter CATEGORIES + reusable SIGNATURE/STAMP assets.
// Mounted at /api/hr/letters/library. Tenant config → canManageLetters.

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/letterLibrary.controller');

router.use(protect);
router.use(requirePermission('canManageLetters'));

router.get('/categories', c.listCategories);
router.post('/categories', c.createCategory);
router.put('/categories/:id', c.updateCategory);
router.delete('/categories/:id', c.deleteCategory);

router.get('/assets', c.listAssets);
router.post('/assets', c.createAsset);
router.delete('/assets/:id', c.deleteAsset);

module.exports = router;
