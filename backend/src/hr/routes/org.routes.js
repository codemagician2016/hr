'use strict';
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee } = require('../middleware/scope.middleware');
const org = require('../controllers/org.controller');

// Feature 1: org reads previously had NO permission gate. Add a floor — any
// authenticated operator with canViewEmployees may READ the org masters; mutations
// still require canManageOrg (Owner/HR-Admin). Org masters are tenant-wide (not
// employee-scoped), so there is intentionally no employee scopeWhere here — only
// the auth/permission floor.
router.use(protect);
router.use(attachSelfEmployee); // Feature 1: hierarchy anchor (consistent stack)

// Feature 1: read-only manager→reports hierarchy for the org-chart UI. Inherits
// protect + attachSelfEmployee above, so ?root=me can root at req.user.employeeId.
router.get('/tree', requirePermission('canViewEmployees'), org.tree);

// Feature 19 — scalable org chart: lazy per-node API (children-of-node, ancestors,
// search-to-locate, scope-clamped roots). All canViewEmployees; the controller
// resolves the F1 band and re-validates every :id with scopeAllows (out-of-scope →
// 404). These power the redesigned virtualized client; the legacy /tree above stays
// for small tenants (soft-capped > 500). Specific paths declared BEFORE the generic
// mountResource('/:id') handlers so 'tree' is never mistaken for a resource id.
router.get('/tree/roots', requirePermission('canViewEmployees'), org.treeRoots);
router.get('/tree/search', requirePermission('canViewEmployees'), org.treeSearch);
router.get('/tree/nodes/:id/children', requirePermission('canViewEmployees'), org.treeChildren);
router.get('/tree/nodes/:id/ancestors', requirePermission('canViewEmployees'), org.treeAncestors);

function mountResource(path, ctrl) {
  router.get(`/${path}`, requirePermission('canViewEmployees'), ctrl.list);
  router.get(`/${path}/:id`, requirePermission('canViewEmployees'), ctrl.get);
  router.post(`/${path}`, requirePermission('canManageOrg'), ctrl.create);
  router.patch(`/${path}/:id`, requirePermission('canManageOrg'), ctrl.update);
  router.delete(`/${path}/:id`, requirePermission('canManageOrg'), ctrl.remove);
}

mountResource('entities', org.entities);
mountResource('locations', org.locations);
mountResource('departments', org.departments);
mountResource('designations', org.designations);
mountResource('grades', org.grades);
mountResource('bands', org.bands);

module.exports = router;
