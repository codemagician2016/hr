'use strict';

/**
 * countryContext.routes.js — Feature 14 operator (hr-admin) country surface,
 * mounted at /api/hr. CUSTOMER-less operator session (req.user.businessId).
 *
 *   POST /setup/country     set the tenant HR country ONCE (canManageCompanyProfile)
 *   GET  /country-context   tenant capability matrix (any authenticated HR operator)
 *
 * The setup endpoint is the ONLY writer of Business.hrCountry (locked-once).
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/countryContext.controller');

router.use(protect);

// Set the tenant HR country once. Admin-only (HR settings band).
router.post('/setup/country', requirePermission('canManageCompanyProfile'), c.setupCountry);

// Capability matrix for the hr-admin app. Any authenticated operator may read it
// (the app needs it on load to gate every country-specific surface).
router.get('/country-context', c.getCountryContext);

module.exports = router;
