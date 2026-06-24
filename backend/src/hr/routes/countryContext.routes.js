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

// NOTE: this router is mounted at the /api/hr ROOT ('/'), so a router-level
// `router.use(protect)` would run operator-auth for EVERY /api/hr/* request —
// including the customer-session /me/* routes — and reject customer tokens with
// "Not authenticated" before requireCustomer is ever reached (it shadowed the
// entire ESS surface). `protect` is therefore scoped PER-ROUTE to the two
// operator endpoints below, never the router root.

// Set the tenant HR country once. Admin-only (HR settings band).
router.post('/setup/country', protect, requirePermission('canManageCompanyProfile'), c.setupCountry);

// Capability matrix for the hr-admin app. Any authenticated operator may read it
// (the app needs it on load to gate every country-specific surface).
router.get('/country-context', protect, c.getCountryContext);

module.exports = router;
