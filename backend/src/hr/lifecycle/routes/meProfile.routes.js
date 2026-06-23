'use strict';

/**
 * meProfile.routes.js — ESS profile/country surface, mounted at
 * /api/hr/me/profile. CUSTOMER session (req.customer); SELF_ONLY by construction
 * (no `:id` path). Exposes the signed-in employee's RESOLVED operating country so
 * every ESS page can gate country-specific UI and fail closed when unknown.
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/meProfile.controller');

router.use(requireCustomer);

router.get('/', c.getMyProfile);

module.exports = router;
