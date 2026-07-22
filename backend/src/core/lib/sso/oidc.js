'use strict';

// OIDC Relying Party wrapper (openid-client v5 — the CJS line; v6+ is ESM-only
// and this backend is CommonJS). Discovery is cached per issuer URL so the
// login redirect doesn't pay a metadata round-trip on every click.

const { Issuer, generators } = require('openid-client');
const { decrypt } = require('../crypto');
const { SsoError } = require('./attributes');

const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h — IdP metadata is near-static
const issuerCache = new Map(); // issuerUrl → { issuer, fetchedAt }

async function discoverIssuer(issuerUrl, { force = false } = {}) {
  const url = String(issuerUrl || '').trim();
  if (!url) throw new SsoError('The OIDC connection has no issuer URL', { code: 'not-configured', status: 503 });
  const hit = issuerCache.get(url);
  if (!force && hit && Date.now() - hit.fetchedAt < DISCOVERY_TTL_MS) return hit.issuer;
  let issuer;
  try {
    issuer = await Issuer.discover(url);
  } catch (e) {
    throw new SsoError(`OIDC discovery failed for ${url}: ${e.message}`, { code: 'discovery-failed', status: 502 });
  }
  issuerCache.set(url, { issuer, fetchedAt: Date.now() });
  return issuer;
}

async function buildClient(connection, redirectUri) {
  if (!connection.clientId) {
    throw new SsoError('The OIDC connection has no client id', { code: 'not-configured', status: 503 });
  }
  const issuer = await discoverIssuer(connection.issuerUrl);
  const clientSecret = connection.clientSecretEnc ? decrypt(connection.clientSecretEnc) : null;
  return new issuer.Client({
    client_id: connection.clientId,
    // PKCE carries public-client flows; a secret upgrades to confidential.
    client_secret: clientSecret || undefined,
    token_endpoint_auth_method: clientSecret ? 'client_secret_basic' : 'none',
    redirect_uris: [redirectUri],
    response_types: ['code'],
  });
}

// Leg 1 — build the IdP authorize URL. Returns everything the callback needs
// to verify (state/nonce/codeVerifier); the caller persists them (stateStore).
async function startLogin({ connection, redirectUri }) {
  const client = await buildClient(connection, redirectUri);
  const state = generators.state();
  const nonce = generators.nonce();
  const codeVerifier = generators.codeVerifier();
  const url = client.authorizationUrl({
    scope: connection.scopes || 'openid email profile',
    state,
    nonce,
    code_challenge: generators.codeChallenge(codeVerifier),
    code_challenge_method: 'S256',
  });
  return { url, state, nonce, codeVerifier };
}

// Leg 2 — exchange the code + verify the ID token. Returns the verified claims.
async function completeLogin({ connection, redirectUri, params, checks }) {
  const client = await buildClient(connection, redirectUri);
  let tokenSet;
  try {
    tokenSet = await client.callback(redirectUri, params, {
      state: checks.state,
      nonce: checks.nonce,
      code_verifier: checks.codeVerifier,
    });
  } catch (e) {
    throw new SsoError(`OIDC code exchange failed: ${e.message}`, { code: 'exchange-failed', status: 401 });
  }
  const claims = tokenSet.claims();
  if (!claims || !claims.sub) {
    throw new SsoError('The IdP returned no usable ID token', { code: 'no-subject', status: 401 });
  }
  return claims;
}

module.exports = { discoverIssuer, startLogin, completeLogin, _issuerCache: issuerCache };
