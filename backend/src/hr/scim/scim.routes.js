'use strict';

// SCIM 2.0 provisioning surface — mounted at app root as /scim/v2
// (backend/src/index.js). Bearer-only (ScimToken — no session, no tenant
// host): the token IS the tenant. IdPs (Okta / Azure AD / OneLogin) POST with
// Content-Type application/scim+json, which the global express.json (type
// application/json) does NOT parse — the router carries its own parser.

const express = require('express');
const router = express.Router();

const asyncHandler = require('../../core/middleware/asyncHandler');
const { resolveApiBaseUrl } = require('../../core/utils/apiBaseUrl');
const { requireScimToken, scimLimiter } = require('./scimAuth.middleware');
const { serviceProviderConfig, resourceTypes, schemasDoc } = require('./envelope');
const users = require('./users.controller');

router.use(express.json({ type: ['application/json', 'application/scim+json'], limit: '1mb' }));
router.use(asyncHandler(requireScimToken));
router.use(scimLimiter);

function base() {
  return `${resolveApiBaseUrl()}/scim/v2`;
}

// ── Discovery (RFC 7644 §4) — static documents ──────────────────────
router.get('/ServiceProviderConfig', (req, res) => {
  res.type('application/scim+json').json(serviceProviderConfig(base()));
});
router.get('/Schemas', (req, res) => {
  res.type('application/scim+json').json(schemasDoc(base()));
});
router.get('/ResourceTypes', (req, res) => {
  res.type('application/scim+json').json(resourceTypes(base()));
});

// ── /Users ──────────────────────────────────────────────────────────
router.get('/Users', asyncHandler(users.list));
router.post('/Users', asyncHandler(users.create));
router.get('/Users/:id', asyncHandler(users.getOne));
router.put('/Users/:id', asyncHandler(users.replace));
router.patch('/Users/:id', asyncHandler(users.patch));
router.delete('/Users/:id', asyncHandler(users.remove));

module.exports = router;
