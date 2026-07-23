'use strict';

// Phase 5c — field-level permissions routes, mounted at /api/hr/field-access.
// A dedicated router (NOT under either /api/rbac role router) so the mount is
// unambiguous. Guarded by canManageEmployees (field access governs employee-field
// visibility; this also guarantees the existing HR operator personas pass without a
// new permission key / role-grant migration).

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('./fieldAccess.controller');

router.use(protect);
const GUARD = requirePermission('canManageEmployees');

router.get('/groups', GUARD, c.listGroups);
router.get('/roles', GUARD, c.listRolesWithAccess);
router.put('/roles/:id', GUARD, c.setRoleFieldAccess);

module.exports = router;
