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
mountResource('grades', org.grades);
mountResource('bands', org.bands);

module.exports = router;
