const express = require('express');
const router = express.Router();
const { getPricing } = require('../controllers/publicPricing.controller');

// Public — no auth required.
router.get('/', getPricing);

module.exports = router;
