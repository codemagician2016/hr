'use strict';

// HR add-on entitlements — mounted at /api/hr/entitlements.
//   GET  /                 the tenant's add-on map (any authenticated operator; nav + BillingTab)
//   POST /:key/grant       super-admin grant/revoke of an add-on (comp / trial / manual)

const express = require('express');
const router = express.Router();
const { protect, requireSuperAdmin } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/entitlements.controller');

router.use(protect);
router.get('/', c.listEntitlements);
router.post('/:key/grant', requireSuperAdmin, c.grantAddOn);

module.exports = router;
