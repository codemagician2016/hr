'use strict';
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee } = require('../middleware/scope.middleware');
const org = require('../controllers/org.controller');
// FLAG (Feature 14 — shared edit): write-guards. Entity/Location create must
// carry the tenant country (absent → stamped; off-country → 422) and an Entity's
// payCurrency must equal the tenant currency. Fail-closed; the hard backstop
// behind the UI gating (a crafted countryCode:'NZ' is rejected server-side).
const {
  assertTenantCountryWrite,
  assertTenantCurrencyWrite,
} = require('../tenant/assertTenantCountry.middleware');

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
// 404). Declared BEFORE the generic mountResource('/:id') so 'tree' isn't taken as an id.
router.get('/tree/roots', requirePermission('canViewEmployees'), org.treeRoots);
router.get('/tree/search', requirePermission('canViewEmployees'), org.treeSearch);
router.get('/tree/nodes/:id/children', requirePermission('canViewEmployees'), org.treeChildren);
router.get('/tree/nodes/:id/ancestors', requirePermission('canViewEmployees'), org.treeAncestors);

// Optional extra create-guards per resource (Feature 14 country/currency lock).
function mountResource(path, ctrl, createGuards = []) {
  router.get(`/${path}`, requirePermission('canViewEmployees'), ctrl.list);
  router.get(`/${path}/:id`, requirePermission('canViewEmployees'), ctrl.get);
  router.post(`/${path}`, requirePermission('canManageOrg'), ...createGuards, ctrl.create);
  router.patch(`/${path}/:id`, requirePermission('canManageOrg'), ctrl.update);
  router.delete(`/${path}/:id`, requirePermission('canManageOrg'), ctrl.remove);
}

// Entity create: country must match the tenant (absent → stamped) and payCurrency
// must equal the tenant currency. Location create: country must match the tenant.
mountResource('entities', org.entities, [
  assertTenantCountryWrite('body.countryCode'),
  assertTenantCurrencyWrite('body.payCurrency'),
]);
mountResource('locations', org.locations, [assertTenantCountryWrite('body.countryCode')]);
mountResource('departments', org.departments);
mountResource('designations', org.designations);
// Grade carries a salary-band currencyCode → must equal the tenant currency
// (absent → stamped; off-currency → 422), mirroring entities/structures. Without
// this an IN tenant could persist an NZD-denominated band (F14 MED finding).
mountResource('grades', org.grades, [assertTenantCurrencyWrite('body.currencyCode')]);
mountResource('bands', org.bands);

module.exports = router;
