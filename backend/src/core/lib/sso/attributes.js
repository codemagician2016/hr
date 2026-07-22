'use strict';

// Pure attribute/claim extraction for the SSO module — NO I/O, NO prisma.
//
// Both protocols normalise to the same identity shape the social-login seam
// already uses (providers/google.js verify() contract):
//   { subject, email, emailVerified, name }
//
// `attributeMap` (SsoConnection.attributeMapJson) lets a tenant override which
// claim/attribute carries each field: { email, name, firstName, lastName }.
// Keys are the LOGICAL fields; values are the IdP claim/attribute names.

class SsoError extends Error {
  constructor(message, { code = 'sso-error', status = 400 } = {}) {
    super(message);
    this.name = 'SsoError';
    this.code = code;
    this.status = status;
  }
}

function cleanMap(attributeMap) {
  return attributeMap && typeof attributeMap === 'object' && !Array.isArray(attributeMap)
    ? attributeMap
    : {};
}

function firstString(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === 'string' && s.trim()) return s.trim();
    if (typeof s === 'number') return String(s);
  }
  return null;
}

function normaliseEmail(raw) {
  const s = firstString(raw);
  if (!s || !s.includes('@')) return null;
  return s.toLowerCase();
}

// ── OIDC ────────────────────────────────────────────────────────────
// `claims` is the verified ID-token claim set (openid-client tokenSet.claims()).
function extractOidcIdentity(claims, attributeMap) {
  const c = claims && typeof claims === 'object' ? claims : {};
  const map = cleanMap(attributeMap);

  const subject = firstString(c.sub);
  if (!subject) {
    throw new SsoError('The identity provider returned no subject (sub claim)', { code: 'no-subject', status: 401 });
  }

  const email = normaliseEmail(map.email ? c[map.email] : null)
    || normaliseEmail(c.email)
    || normaliseEmail(c.preferred_username)
    || normaliseEmail(c.upn);
  if (!email) {
    throw new SsoError('The identity provider returned no email claim', { code: 'no-email', status: 400 });
  }

  const first = firstString(map.firstName ? c[map.firstName] : null, c.given_name);
  const last = firstString(map.lastName ? c[map.lastName] : null, c.family_name);
  const name = firstString(map.name ? c[map.name] : null, c.name)
    || [first, last].filter(Boolean).join(' ')
    || email.split('@')[0];

  return {
    subject,
    email,
    // OIDC providers that assert email_verified:false are surfaced as-is; the
    // caller decides (v1: employee-email match is the real gate, so we accept).
    emailVerified: c.email_verified !== false,
    name,
    firstName: first || null,
    lastName: last || null,
  };
}

// ── SAML ────────────────────────────────────────────────────────────
// `profile` is the validated node-saml profile: nameID + flattened assertion
// attributes as extra properties. Common IdP attribute spellings are tried in
// order; the tenant attributeMap wins over all of them.
const SAML_EMAIL_ATTRS = [
  'email', 'mail', 'emailAddress', 'Email',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
];
const SAML_NAME_ATTRS = [
  'displayName', 'cn', 'name',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'urn:oid:2.16.840.1.113730.3.1.241',
];
const SAML_FIRST_ATTRS = [
  'givenName', 'firstName', 'first_name',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
  'urn:oid:2.5.4.42',
];
const SAML_LAST_ATTRS = [
  'sn', 'surname', 'lastName', 'last_name',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
  'urn:oid:2.5.4.4',
];

function pickAttr(profile, names) {
  for (const n of names) {
    const v = firstString(profile[n]);
    if (v) return v;
  }
  return null;
}

function extractSamlIdentity(profile, attributeMap) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const map = cleanMap(attributeMap);

  const subject = firstString(p.nameID);
  if (!subject) {
    throw new SsoError('The SAML assertion carried no NameID', { code: 'no-subject', status: 401 });
  }

  const email = normaliseEmail(map.email ? p[map.email] : null)
    || pickAttrEmail(p)
    || normaliseEmail(p.nameID); // email-format NameID is the most common setup
  if (!email) {
    throw new SsoError('The SAML assertion carried no email attribute (and the NameID is not an email)', { code: 'no-email', status: 400 });
  }

  const first = firstString(map.firstName ? p[map.firstName] : null) || pickAttr(p, SAML_FIRST_ATTRS);
  const last = firstString(map.lastName ? p[map.lastName] : null) || pickAttr(p, SAML_LAST_ATTRS);
  const name = firstString(map.name ? p[map.name] : null)
    || pickAttr(p, SAML_NAME_ATTRS)
    || [first, last].filter(Boolean).join(' ')
    || email.split('@')[0];

  return {
    subject,
    email,
    emailVerified: true, // a signed assertion from the tenant's own IdP is authoritative
    name,
    firstName: first || null,
    lastName: last || null,
  };
}

function pickAttrEmail(profile) {
  for (const n of SAML_EMAIL_ATTRS) {
    const v = normaliseEmail(profile[n]);
    if (v) return v;
  }
  return null;
}

// ── Login-target resolution ─────────────────────────────────────────
// connection.loginTarget ESS|OPERATOR|BOTH; the ?target= query may narrow a
// BOTH connection (and must agree with a single-target one). Default: ESS.
function pickTarget(connection, requestedTarget) {
  const configured = String(connection?.loginTarget || 'ESS').toUpperCase();
  const requested = requestedTarget ? String(requestedTarget).toUpperCase() : null;
  if (requested && !['ESS', 'OPERATOR'].includes(requested)) {
    throw new SsoError(`Unknown login target: ${requestedTarget}`, { code: 'bad-target', status: 400 });
  }
  if (configured === 'BOTH') return requested || 'ESS';
  if (requested && requested !== configured) {
    throw new SsoError(`This SSO connection only signs into ${configured}`, { code: 'target-not-allowed', status: 403 });
  }
  return configured;
}

module.exports = {
  SsoError,
  extractOidcIdentity,
  extractSamlIdentity,
  pickTarget,
  // exported for unit tests
  _internals: { normaliseEmail, firstString },
};
