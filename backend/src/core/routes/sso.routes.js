'use strict';

// Public SSO surface — mounted at app root as /sso (backend/src/index.js).
// NO session auth (these ARE the login endpoints); tenant slug rides the path
// because IdP-initiated SAML POSTs carry no tenant Host header.
//
// The SAML ACS is form-encoded (HTTP-POST binding) — express.urlencoded is
// applied on THAT route only; the global express.json never touches it.

const express = require('express');
const router = express.Router();

const asyncHandler = require('../middleware/asyncHandler');
const { authLimiter } = require('../middleware/abuse.middleware');
const c = require('../controllers/sso.controller');

// Login-page button probe (public, cheap, no limiter beyond default).
router.get('/:tenant/status', asyncHandler(c.status));

// OIDC (protocol-dispatching: a SAML tenant hitting /login is forwarded to
// the AuthnRequest leg so login pages can use ONE url).
router.get('/:tenant/login', authLimiter, asyncHandler(c.login));
router.get('/:tenant/callback', authLimiter, asyncHandler(c.oidcCallback));

// SAML SP.
router.get('/:tenant/metadata', asyncHandler(c.samlMetadata));
router.get('/:tenant/saml/login', authLimiter, asyncHandler(c.samlLogin));
router.post(
  '/:tenant/saml/acs',
  authLimiter,
  express.urlencoded({ extended: false, limit: '1mb' }),
  asyncHandler(c.samlAcs),
);

module.exports = router;
