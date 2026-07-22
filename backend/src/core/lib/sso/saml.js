'use strict';

// SAML 2.0 Service Provider wrapper over @node-saml/node-saml (v5).
// The library owns signature validation, audience/conditions checks and
// AuthnRequest generation — this file only maps an SsoConnection row +
// tenant slug into a configured SAML instance.

const { SAML } = require('@node-saml/node-saml');
const { resolveApiBaseUrl } = require('../../utils/apiBaseUrl');
const { decrypt } = require('../crypto');
const { SsoError } = require('./attributes');

// Accept either a full PEM block or bare base64 (IdP metadata copy-paste) and
// normalise to PEM — node-saml v5 wants a parseable cert.
function certToPem(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.includes('-----BEGIN')) return s;
  const body = s.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

function spEntityId(slug) {
  return `${resolveApiBaseUrl()}/sso/${slug}/metadata`;
}

function acsUrl(slug) {
  return `${resolveApiBaseUrl()}/sso/${slug}/saml/acs`;
}

function buildSaml(connection, slug) {
  if (!connection.idpSsoUrl || !connection.idpCertPem) {
    throw new SsoError('The SAML connection is missing the IdP SSO URL or signing certificate', {
      code: 'not-configured', status: 503,
    });
  }
  const entityId = spEntityId(slug);
  const options = {
    callbackUrl: acsUrl(slug),
    entryPoint: connection.idpSsoUrl,
    issuer: entityId,
    idpCert: certToPem(connection.idpCertPem),
    audience: entityId,
    wantAssertionsSigned: connection.wantAssertionsSigned !== false,
    // The IdP signs either the Response or the Assertion (or both) depending on
    // vendor defaults; wantAssertionsSigned above enforces the assertion leg.
    wantAuthnResponseSigned: false,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    acceptedClockSkewMs: 5000,
  };
  const spKey = connection.spPrivateKeyEnc ? decrypt(connection.spPrivateKeyEnc) : null;
  if (spKey) {
    options.privateKey = spKey;
    options.signatureAlgorithm = 'sha256';
  }
  return new SAML(options);
}

// SP metadata XML for the tenant to upload/paste into their IdP.
function buildMetadata(connection, slug) {
  const saml = buildSaml(connection, slug);
  return saml.generateServiceProviderMetadata(null, null);
}

// AuthnRequest redirect URL (SP-initiated). RelayState carries the per-request
// login context (target/redirect) — the tenant itself rides the ACS path.
async function buildLoginUrl(connection, slug, relayState) {
  const saml = buildSaml(connection, slug);
  return saml.getAuthorizeUrlAsync(relayState || '', undefined, {});
}

// ACS: validate the POSTed SAMLResponse (signature, audience, conditions,
// InResponseTo is not enforced in v1 — IdP-initiated logins carry none).
async function validateAcs(connection, slug, body) {
  const saml = buildSaml(connection, slug);
  let out;
  try {
    out = await saml.validatePostResponseAsync({
      SAMLResponse: body.SAMLResponse,
      RelayState: body.RelayState,
    });
  } catch (e) {
    throw new SsoError(`SAML response validation failed: ${e.message}`, { code: 'saml-invalid', status: 401 });
  }
  if (!out || !out.profile || out.loggedOut) {
    throw new SsoError('SAML response carried no signed-in subject', { code: 'saml-invalid', status: 401 });
  }
  return out.profile;
}

module.exports = { buildSaml, buildMetadata, buildLoginUrl, validateAcs, certToPem, spEntityId, acsUrl };
