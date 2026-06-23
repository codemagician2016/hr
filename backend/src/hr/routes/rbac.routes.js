'use strict';

/**
 * rbac.routes.js — Feature 10 §7.4 RBAC + hierarchy admin surface. Mounted at
 * /api/hr/rbac (see routes/index.js). All routes require `protect`. Role + grant
 * management is gated by canManageRoles; the org tree read by canViewEmployees; the
 * re-parent by canManageHierarchy; assign-role by canManageRoles.
 *
 * Literal paths precede `:id` param routes.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/rbac.controller');

router.use(protect);

const ROLES = requirePermission('canManageRoles');
const HIER = requirePermission('canManageHierarchy');
const VIEW = requirePermission('canViewEmployees');

// ── Permissions catalog (for the role builder) ──
router.get('/permissions', ROLES, c.listPermissions);

// ── Roles CRUD + grants (canManageRoles) ──
router.get('/roles', ROLES, c.listRoles);
router.post('/roles', ROLES, c.createRole);
router.put('/roles/:id', ROLES, c.updateRole);
router.delete('/roles/:id', ROLES, c.deleteRole);
router.post('/roles/:id/grants', ROLES, c.addGrant);

// ── Org tree (read) + re-parent (canManageHierarchy) + assign role ──
router.get('/org-tree', VIEW, c.orgTree);
router.patch('/employees/:id', HIER, c.reparent);
router.post('/employees/:id/assign-role', ROLES, c.assignRole);

module.exports = router;
