// Customer-facing notification config routes (BUSINESS_ADMIN scope).
// Mounted at /api/notification-config.
'use strict';

const express = require('express');
const { protect, requireRole } = require('../../core/middleware/auth.middleware');
const { ROLES } = require('../../core/lib/roles');
const {
  getMyConfig,
  updateEventChannels,
  requestAccess,
  updateQuotaAction,
  buyPack,
  acceptSmsTerms,
} = require('../controllers/notificationConfig.controller');

const router = express.Router();

router.use(protect);
router.use(requireRole(ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN));

router.get('/', getMyConfig);
router.put('/event-channels', updateEventChannels);
router.post('/request-access', requestAccess);
router.put('/quota-action', updateQuotaAction);
router.post('/buy-pack', buyPack);
router.post('/accept-sms-terms', acceptSmsTerms);

module.exports = router;
