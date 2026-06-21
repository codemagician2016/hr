'use strict';
const express = require('express');
const { protect, requireRole } = require('../../core/middleware/auth.middleware');
const { ROLES } = require('../../core/lib/roles');
const c = require('../controllers/businessRoles.controller');

const router = express.Router();
router.use(protect);
router.use(requireRole(ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN));

router.get('/permissions', c.listPermissions);
router.get('/roles', c.listRoles);
router.post('/roles', c.createRole);
router.put('/roles/:id', c.updateRole);
router.delete('/roles/:id', c.deleteRole);
router.post('/seed-system-roles', c.seedSystemRoles);

module.exports = router;
