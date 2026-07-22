'use strict';

// Public SSO endpoints (mounted at /sso — NO session; tenant rides the path
// because IdP-initiated POSTs carry no tenant Host header):
//
//   GET  /sso/:tenant/status       → { configured, protocol, displayName } (login-page buttons)
//   GET  /sso/:tenant/login        → protocol dispatch: OIDC authorize 302 / SAML AuthnRequest 302
//   GET  /sso/:tenant/callback     → OIDC code exchange → identity → one-time code → tenant host
//   GET  /sso/:tenant/metadata     → SAML SP metadata XML
//   GET  /sso/:tenant/saml/login   → SAML AuthnRequest 302 (explicit path)
//   POST /sso/:tenant/saml/acs     → SAML assertion validation (urlencoded)
//
// Session hop: after resolveIdentity() the flow mirrors the social-login
// two-leg exchange — issueAuthCode() mints a single-use Redis code, the user
// is 302'd to the app host /sso/complete?code=…, and the app POSTs the code to
//   POST /api/customer/sso/exchange   (ESS  → Customer cookie)
//   POST /api/auth/sso/exchange       (OPERATOR → User cookie)
// which set the JWT cookie on the app's own host (the only place a host-scoped
// cookie can be set).

const prisma = require('../lib/prisma');
const sso = require('../lib/sso');
const { issueAuthCode, consumeAuthCode } = require('../lib/socialAuth');
const { setCustomerTokenCookie, setTokenCookie, generateToken } = require('../utils/generateToken');
const { sanitiseRedirect } = require('./social.controller');
const { resolveApiBaseUrl } = require('../utils/apiBaseUrl');

const { SsoError, pickTarget, connectionConfigured } = sso;

// ── Tenant + connection resolution (slug in path) ───────────────────
async function resolveTenant(slugParam) {
  const slug = String(slugParam || '').toLowerCase().trim();
  if (!slug) throw new SsoError('Missing tenant', { code: 'bad-tenant', status: 400 });
  const business = await prisma.business.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      isActive: true,
      ssoConnection: true,
      subscription: {
        select: { customDomain: true, customDomainVerified: true, customDomainStatus: true },
      },
    },
  });
  if (!business || business.isActive === false) {
    throw new SsoError(`Unknown organisation: ${slug}`, { code: 'bad-tenant', status: 404 });
  }
  return { business, connection: business.ssoConnection };
}

function requireActiveConnection(connection) {
  if (!connection || !connection.isActive || !connectionConfigured(connection)) {
    throw new SsoError('Single sign-on is not configured for this organisation.', {
      code: 'not-configured', status: 404,
    });
  }
  return connection;
}

// ── App-host resolution for the final redirect ──────────────────────
// ESS lives on the tenant host (custom domain when verified+ACTIVE, else
// <slug>.<PLATFORM_DOMAIN>); the operator console lives on the platform app
// origin (same precedence approvals/notify.js uses for deep links).
function essBaseUrl(business) {
  const sub = business.subscription;
  if (sub && sub.customDomain && sub.customDomainVerified && sub.customDomainStatus === 'ACTIVE') {
    return `https://${sub.customDomain}`;
  }
  const domain = (process.env.PLATFORM_DOMAIN || 'drifthr.com').toLowerCase();
  return `https://${business.slug}.${domain}`;
}

function operatorBaseUrl() {
  const base = process.env.NEXT_PUBLIC_PLATFORM_URL || process.env.FRONTEND_URL;
  if (base) return String(base).replace(/\/$/, '');
  return `https://${process.env.PLATFORM_DOMAIN || 'drifthr.com'}`;
}

function completeRedirect({ business, target, code, redirect }) {
  const base = target === 'OPERATOR' ? operatorBaseUrl() : essBaseUrl(business);
  const url = new URL(`${base}/sso/complete`);
  url.searchParams.set('code', code);
  if (target === 'OPERATOR') url.searchParams.set('target', 'operator');
  const safe = sanitiseRedirect(redirect);
  if (safe) url.searchParams.set('redirect', safe);
  return url.toString();
}

// ── Error surface: JSON for API callers, a minimal page for browsers ──
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function sendSsoError(req, res, err) {
  const status = err instanceof SsoError ? err.status : 500;
  const message = err instanceof SsoError ? err.message : 'Single sign-on failed. Please try again.';
  const code = err instanceof SsoError ? err.code : 'sso-error';
  if (!(err instanceof SsoError)) {
    console.error('[sso] unexpected error:', err && err.message ? err.message : err);
  }
  if ((req.get('Accept') || '').includes('application/json')) {
    return res.status(status).json({ message, code });
  }
  return res.status(status).type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign-in problem</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f6f7f9;color:#1a1d21}
.card{max-width:26rem;background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:2rem;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.06)}
h1{font-size:1.1rem;margin:0 0 .5rem}p{margin:.25rem 0;color:#4b5563;font-size:.95rem}.code{color:#9aa1a9;font-size:.8rem;margin-top:1rem}</style></head>
<body><div class="card"><h1>We couldn't sign you in</h1><p>${escapeHtml(message)}</p><p class="code">${escapeHtml(code)}</p></div></body></html>`);
}

// After a validated assertion: principal → one-time code → app host.
async function finishLogin({ req, res, business, connection, identity, target, protocol, redirect }) {
  const resolved = await sso.resolveIdentity({ business, connection, identity, target, protocol });
  const code = await issueAuthCode(
    resolved.kind === 'operator'
      ? { kind: 'sso-operator', userId: resolved.userId, businessId: resolved.businessId }
      : { kind: 'sso-customer', customerId: resolved.customerId, businessId: resolved.businessId },
  );
  return res.redirect(302, completeRedirect({
    business, target, code, redirect,
  }));
}

// ── GET /sso/:tenant/status (public — login-page buttons) ───────────
async function status(req, res) {
  try {
    const { business, connection } = await resolveTenant(req.params.tenant);
    const configured = Boolean(connection && connection.isActive && connectionConfigured(connection));
    return res.json({
      configured,
      protocol: configured ? connection.protocol : null,
      displayName: configured ? (connection.displayName || 'Single sign-on') : null,
      loginTarget: configured ? connection.loginTarget : null,
      tenant: business.slug,
    });
  } catch (err) {
    if (err instanceof SsoError && err.code === 'bad-tenant') {
      return res.status(err.status).json({ configured: false, message: err.message });
    }
    throw err;
  }
}

// ── GET /sso/:tenant/login — protocol dispatch ──────────────────────
async function login(req, res) {
  try {
    const { business, connection } = await resolveTenant(req.params.tenant);
    requireActiveConnection(connection);
    if (connection.protocol === 'SAML') return await startSamlLogin(req, res, business, connection);
    return await startOidcLogin(req, res, business, connection);
  } catch (err) {
    return sendSsoError(req, res, err);
  }
}

async function startOidcLogin(req, res, business, connection) {
  const target = pickTarget(connection, req.query.target);
  const redirectUri = `${resolveApiBaseUrl()}/sso/${business.slug}/callback`;
  const { url, state, nonce, codeVerifier } = await sso.oidc.startLogin({ connection, redirectUri });
  // Keyed by the OAuth round-trip `state` param — the callback consumes it
  // (single-use) and verifies nonce + PKCE against these stored values.
  await sso.stateStore.putState(state, {
    tenant: business.slug,
    target,
    nonce,
    codeVerifier,
    redirect: sanitiseRedirect(req.query.redirect) || null,
  });
  return res.redirect(302, url);
}

// ── GET /sso/:tenant/callback (OIDC) ────────────────────────────────
async function oidcCallback(req, res) {
  try {
    const { business, connection } = await resolveTenant(req.params.tenant);
    requireActiveConnection(connection);
    if (connection.protocol !== 'OIDC') {
      throw new SsoError('This organisation uses SAML sign-on.', { code: 'wrong-protocol', status: 400 });
    }
    if (req.query.error) {
      throw new SsoError(`The identity provider returned an error: ${req.query.error_description || req.query.error}`, {
        code: 'idp-error', status: 401,
      });
    }
    const entry = await sso.stateStore.takeState(req.query.state);
    if (!entry || entry.tenant !== business.slug) {
      throw new SsoError('Your sign-in session expired — please try again.', { code: 'state-expired', status: 401 });
    }
    const redirectUri = `${resolveApiBaseUrl()}/sso/${business.slug}/callback`;
    const claims = await sso.oidc.completeLogin({
      connection,
      redirectUri,
      params: { code: req.query.code, state: req.query.state },
      checks: { state: req.query.state, nonce: entry.nonce, codeVerifier: entry.codeVerifier },
    });
    const identity = sso.extractOidcIdentity(claims, connection.attributeMapJson);
    return await finishLogin({
      req, res, business, connection, identity,
      target: entry.target, protocol: 'OIDC', redirect: entry.redirect,
    });
  } catch (err) {
    return sendSsoError(req, res, err);
  }
}

// ── GET /sso/:tenant/metadata (SAML SP metadata XML) ────────────────
async function samlMetadata(req, res) {
  try {
    const { business, connection } = await resolveTenant(req.params.tenant);
    if (!connection || connection.protocol !== 'SAML') {
      throw new SsoError('SAML is not configured for this organisation.', { code: 'not-configured', status: 404 });
    }
    const xml = sso.saml.buildMetadata(connection, business.slug);
    return res.type('application/xml').send(xml);
  } catch (err) {
    return sendSsoError(req, res, err);
  }
}

// ── GET /sso/:tenant/saml/login (SP-initiated AuthnRequest) ─────────
async function samlLogin(req, res) {
  try {
    const { business, connection } = await resolveTenant(req.params.tenant);
    requireActiveConnection(connection);
    if (connection.protocol !== 'SAML') {
      throw new SsoError('This organisation uses OIDC sign-on.', { code: 'wrong-protocol', status: 400 });
    }
    return await startSamlLogin(req, res, business, connection);
  } catch (err) {
    return sendSsoError(req, res, err);
  }
}

async function startSamlLogin(req, res, business, connection) {
  const target = pickTarget(connection, req.query.target);
  // RelayState: tenant+target (+optional path redirect). The tenant also rides
  // the ACS path — the RelayState copy lets us detect cross-tenant replays.
  const relayState = JSON.stringify({
    t: business.slug,
    g: target,
    ...(sanitiseRedirect(req.query.redirect) ? { r: sanitiseRedirect(req.query.redirect) } : {}),
  });
  const url = await sso.saml.buildLoginUrl(connection, business.slug, relayState);
  return res.redirect(302, url);
}

// ── POST /sso/:tenant/saml/acs (urlencoded — SP + IdP initiated) ────
async function samlAcs(req, res) {
  try {
    const { business, connection } = await resolveTenant(req.params.tenant);
    requireActiveConnection(connection);
    if (connection.protocol !== 'SAML') {
      throw new SsoError('This organisation uses OIDC sign-on.', { code: 'wrong-protocol', status: 400 });
    }
    if (!req.body || !req.body.SAMLResponse) {
      throw new SsoError('Missing SAMLResponse', { code: 'saml-invalid', status: 400 });
    }
    const profile = await sso.saml.validateAcs(connection, business.slug, req.body);

    // RelayState: ours is JSON {t,g,r}; an IdP-initiated login may carry an
    // arbitrary (or empty) value → fall back to the connection default target.
    let target = pickTarget(connection, null);
    let redirect = null;
    if (req.body.RelayState) {
      try {
        const rs = JSON.parse(req.body.RelayState);
        if (rs && rs.t && rs.t !== business.slug) {
          throw new SsoError('RelayState tenant mismatch', { code: 'saml-invalid', status: 401 });
        }
        if (rs && rs.g) target = pickTarget(connection, rs.g);
        if (rs && rs.r) redirect = rs.r;
      } catch (e) {
        if (e instanceof SsoError) throw e;
        /* non-JSON RelayState (IdP-initiated) — keep defaults */
      }
    }

    const identity = sso.extractSamlIdentity(profile, connection.attributeMapJson);
    return await finishLogin({
      req, res, business, connection, identity, target, protocol: 'SAML', redirect,
    });
  } catch (err) {
    return sendSsoError(req, res, err);
  }
}

// ── Exchange leg (mirrors social.controller socialExchange) ─────────
// POST /api/customer/sso/exchange { code } → Customer cookie on this host.
async function customerSsoExchange(req, res) {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ message: 'code is required' });
  const entry = await consumeAuthCode(code);
  if (!entry || entry.kind !== 'sso-customer' || !entry.customerId) {
    return res.status(401).json({ message: 'Invalid or expired code' });
  }
  const customer = await prisma.customer.findUnique({
    where: { id: entry.customerId },
    select: { id: true, email: true, name: true, businessId: true, isActive: true, anonymisedAt: true },
  });
  if (!customer || customer.businessId !== entry.businessId) {
    return res.status(404).json({ message: 'Account not found' });
  }
  if (!customer.isActive || customer.anonymisedAt) {
    return res.status(403).json({ message: 'This account is no longer active.' });
  }
  setCustomerTokenCookie(res, { id: customer.id, businessId: customer.businessId }, req);
  return res.json({
    customer: { id: customer.id, email: customer.email, name: customer.name, businessId: customer.businessId },
  });
}

// POST /api/auth/sso/exchange { code } → operator User cookie on this host.
async function operatorSsoExchange(req, res) {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ message: 'code is required' });
  const entry = await consumeAuthCode(code);
  if (!entry || entry.kind !== 'sso-operator' || !entry.userId) {
    return res.status(401).json({ message: 'Invalid or expired code' });
  }
  const user = await prisma.user.findUnique({
    where: { id: entry.userId },
    select: { id: true, email: true, name: true, role: true, businessId: true, isActive: true },
  });
  if (!user || user.businessId !== entry.businessId) {
    return res.status(404).json({ message: 'Account not found' });
  }
  if (!user.isActive) {
    return res.status(403).json({ message: 'This account is no longer active.' });
  }
  setTokenCookie(res, generateToken({ id: user.id }), req);
  const business = user.businessId
    ? await prisma.business.findUnique({
        where: { id: user.businessId },
        select: { id: true, slug: true, name: true },
      })
    : null;
  return res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role, businessId: user.businessId },
    business,
  });
}

module.exports = {
  status,
  login,
  oidcCallback,
  samlMetadata,
  samlLogin,
  samlAcs,
  customerSsoExchange,
  operatorSsoExchange,
  // exported for reuse/tests
  _internals: {
    resolveTenant, essBaseUrl, operatorBaseUrl, completeRedirect,
  },
};
