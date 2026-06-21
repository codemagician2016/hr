const express = require('express');
const router = express.Router();
const { setLocale } = require('../controllers/locale.controller');

// Public — accepts both authenticated and guest callers; the controller
// quietly persists for logged-in viewers and no-ops for guests.
router.post('/', setLocale);

module.exports = router;
