'use strict';
const express = require('express');
const { protect, requireRole } = require('../../core/middleware/auth.middleware');
const { ROLES } = require('../../core/lib/roles');
const c = require('../controllers/publicApi.controller');

const router = express.Router();
router.use(protect);
router.use(requireRole(ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN));

router.get('/keys', c.listKeys);
router.post('/keys', c.createKey);
router.delete('/keys/:id', c.revokeKey);

router.get('/webhooks', c.listSubs);
router.post('/webhooks', c.createSub);
router.post('/webhooks/:id/test', c.testSub);
router.delete('/webhooks/:id', c.deleteSub);
router.get('/webhooks/deliveries', c.listDeliveries);
router.post('/webhooks/deliveries/:id/replay', c.replayDelivery);

module.exports = router;
