'use strict';

// Enterprise SSO core — SAML 2.0 SP + OIDC RP (v1).
//
// Layout:
//   attributes.js      pure claim/attribute → identity extraction + SsoError
//   oidc.js            openid-client v5 RP (discovery cache, PKCE, code flow)
//   saml.js            @node-saml SP (metadata, AuthnRequest, ACS validation)
//   stateStore.js      Redis-backed OIDC state/nonce/PKCE store (single-use)
//   resolveIdentity.js verified identity → Customer/User principal (JIT-aware)
//
// HTTP surface lives in core/controllers/sso.controller.js, mounted at /sso
// (public, tenant-in-path) — see backend/src/index.js.

const attributes = require('./attributes');
const oidc = require('./oidc');
const saml = require('./saml');
const stateStore = require('./stateStore');
const { resolveIdentity, providerFor, splitName } = require('./resolveIdentity');

// Is a connection functionally complete for its protocol?
function connectionConfigured(connection) {
  if (!connection) return false;
  if (connection.protocol === 'OIDC') return Boolean(connection.issuerUrl && connection.clientId);
  if (connection.protocol === 'SAML') return Boolean(connection.idpSsoUrl && connection.idpCertPem);
  return false;
}

module.exports = {
  ...attributes,
  oidc,
  saml,
  stateStore,
  resolveIdentity,
  providerFor,
  splitName,
  connectionConfigured,
};
