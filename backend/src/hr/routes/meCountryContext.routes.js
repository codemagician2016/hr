'use strict';

/**
 * meCountryContext.routes.js — Feature 14 ESS country surface, mounted at
 * /api/hr/me/country-context. CUSTOMER session (req.customer.businessId), read-only.
 *
 *   GET / — the signed-in employee's tenant capability matrix. The ESS app gates
 *           its onboarding statutory step / tax declaration / currency formatting
 *           off `capabilities`, never a hard-coded country literal.
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/countryContext.controller');

router.use(requireCustomer);
router.get('/', c.getMyCountryContext);

module.exports = router;
