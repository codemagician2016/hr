const express = require('express');
const router = express.Router();
const { resolve, me } = require('../controllers/tenant.controller');
const { protect } = require('../../core/middleware/auth.middleware');

// Public — the business frontend calls this on first load to identify itself
router.get('/resolve', resolve);

// Auth-required — unified-admin domain (app.aapkatech.com) calls this to
// resolve the logged-in user's business since the URL has no slug.
router.get('/me', protect, me);

module.exports = router;
