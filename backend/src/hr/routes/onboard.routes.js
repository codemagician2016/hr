'use strict';

// Feature 17 — Onboard-by-CTC route. Mounted at /api/hr/onboard. The single
// endpoint POST /onboard/by-ctc creates an Employee + a CompensationRevision(HIRE)
// in one transaction from { person, policyId, ctcAnnual, dateOfJoining }, reusing
// the shared hire-pay math so a direct hire matches an ATS hire to the paise.
//
// RBAC: the actor must be able to BOTH create employees (canManageEmployees) AND
// manage compensation (canManageCompensation) — onboarding-by-CTC is exactly the
// intersection of those two privileges. requirePermission chains as an AND-gate.
const express = require('express');

const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee } = require('../middleware/scope.middleware');
const { assertTenantCountryWrite } = require('../tenant/assertTenantCountry.middleware');
const c = require('../controllers/onboard.controller');

router.use(protect);
router.use(attachSelfEmployee);

router.post(
  '/by-ctc',
  requirePermission('canManageEmployees'),
  requirePermission('canManageCompensation'),
  // If a person.countryCode IS supplied it must equal the tenant (off-country → 422);
  // absent is allowed (the controller stamps the tenant country itself).
  assertTenantCountryWrite('body.person.countryCode', { stampWhenAbsent: false }),
  c.byCtc,
);

module.exports = router;
