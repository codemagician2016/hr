// Super-admin notification access routes. Mounted at
// /api/admin/notification-access (requires SUPER_ADMIN role).
'use strict';

const express = require('express');
const { requireAuth, requireSuperAdmin } = require('../../core/middleware/auth.middleware');
const {
  listTenants,
  getTenantDetail,
  updateGates,
  reviewRequest,
  listTierBudgets,
  updateTierBudget,
} = require('../controllers/notificationAccess.controller');

const router = express.Router();

router.use(requireAuth);
router.use(requireSuperAdmin);

// Tier-level (the global knob)
router.get('/pricing-tiers', listTierBudgets);
router.put('/pricing-tiers/:tierId/budget', updateTierBudget);

// Per-tenant (the gate)
router.get('/', listTenants);
router.get('/:businessId', getTenantDetail);
router.put('/:businessId/gates', updateGates);
router.put('/:businessId/request-status', reviewRequest);

module.exports = router;
