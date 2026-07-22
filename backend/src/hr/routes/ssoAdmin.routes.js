'use strict';

// SSO + SCIM tenant admin — mounted at /api/hr/sso (hr/routes/index.js).
// protect + canManageSso (Owner via all-true; HR-Admin via the preset).

const express = require('express');
const router = express.Router();

const asyncHandler = require('../../core/middleware/asyncHandler');
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/ssoAdmin.controller');

router.use(protect, requirePermission('canManageSso'));

router.get('/connection', asyncHandler(c.getConnection));
router.put('/connection', asyncHandler(c.putConnection));
router.post('/connection/test', asyncHandler(c.testConnection));
router.delete('/connection', asyncHandler(c.deleteConnection));

router.get('/scim-tokens', asyncHandler(c.listScimTokens));
router.post('/scim-tokens', asyncHandler(c.createScimToken));
router.delete('/scim-tokens/:id', asyncHandler(c.deleteScimToken));

module.exports = router;
