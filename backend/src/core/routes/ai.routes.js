'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { protect, requireRole } = require('../../core/middleware/auth.middleware');
const { ROLES } = require('../../core/lib/roles');
const c = require('../controllers/ai.controller');

const router = express.Router();

// AI generation spends real tokens per call — throttle per business (fall back
// to IP). 30 generations / 5 min is comfortable for interactive editing while
// capping a runaway loop or a single tenant burning the whole quota.
const aiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.businessId || ipKeyGenerator(req.ip || ''),
  handler: (req, res) => res.status(429).json({
    message: 'Too many AI generations. Please wait a minute and try again.',
    code: 'ai_rate_limited',
  }),
});

// Capability probe — cheap, no model call. Lets the admin UI show/hide buttons.
router.get('/status', protect, requireRole(ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN), c.status);

// The paid generation endpoint.
router.post(
  '/generate-content',
  protect,
  requireRole(ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN),
  aiLimiter,
  c.generateContent,
);

module.exports = router;
