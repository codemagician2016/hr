const express = require('express');
const router = express.Router();
const { lookupIndiaPincode, getGeoConfig } = require('../controllers/geo.controller');

// Public — used by onboarding (no business yet) + the billing address form.
router.get('/config', getGeoConfig);
router.get('/in-pincode/:pin', lookupIndiaPincode);

module.exports = router;
