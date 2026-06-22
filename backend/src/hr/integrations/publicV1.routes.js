'use strict';

/**
 * publicV1.routes.js — minimal READ-ONLY public HR API.
 * Mounted by the HR aggregator at /api/hr/v1.
 *
 * Auth: ApiKey (Authorization: Bearer sp_live_...). Reuses the existing
 * apiKey.middleware (requireApiKey attaches req.business + req.apiKey, touches
 * lastUsedAt) and the per-key rate limiter. Reads require scope 'employees'.
 */

const express = require('express');
const router = express.Router();
const { requireApiKey, requireScope } = require('../../core/middleware/apiKey.middleware');
const { apiKeyLimiter } = require('../../core/middleware/abuse.middleware');
const c = require('./publicV1.controller');

router.use(requireApiKey);
// Rate-limit per key (after key resolves so it keys on the key, not the IP).
router.use(apiKeyLimiter);

// Identity probe — no scope required.
router.get('/whoami', c.whoami);

// Read-only employee directory.
router.get('/employees', requireScope('read', 'employees'), c.listEmployees);
router.get('/employees/:id', requireScope('read', 'employees'), c.getEmployee);

module.exports = router;
