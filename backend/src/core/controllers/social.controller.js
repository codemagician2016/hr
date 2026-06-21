'use strict';

// Provider-agnostic social login (Google now; Apple / Microsoft / … later).
//
// Two-leg flow (works for platform subdomains AND verified custom domains):
//   1. POST /api/customer/social/:provider/start   (called on the platform
//      origin, the single authorised OAuth JS origin) → verifies the token,
//      links/creates the customer, returns a one-time code + return URL.
//   2. POST /api/customer/social/exchange           (called on the tenant
//      host) → consumes the code, sets the JWT cookie on that host.
//
// Legacy aliases (/google-auth-code, /exchange-code, /google-auth) delegate
// here so older deployed frontends keep working during rollout.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const {
  getProvider,
  resolveTenantByHost,
  issueAuthCode,
  consumeAuthCode,
} = require('../lib/socialAuth');
const { setCustomerTokenCookie } = require('../utils/generateToken');
const { sendCustomerWelcomeEmail } = require('../utils/email');
const { resolveRecipientLocale } = require('../lib/locale');
const { claimOrdersForCustomer } = require('../../shop/controllers/order.controller');

// Fire-and-forget — never block auth on guest-order attachment failure.
function fireClaim({ customerId, businessId, email }) {
  claimOrdersForCustomer({ customerId, businessId, email })
    .catch((err) => console.error('[social auth] order claim failed:', err?.message));
}

// Fire-and-forget — merge the guest session cart into the customer cart after
// social sign-in. Parity with email/password login; previously social logins
// claimed past orders but silently dropped the guest's in-progress cart.
const cartLib = require('../lib/cart');
function fireCartMerge({ customerId, businessId, sessionId }) {
  if (!cartLib.isValidSessionId(sessionId)) return;
  cartLib.mergeGuestCartIntoCustomer({ prisma, businessId, customerId, sessionId })
    .catch((err) => console.error('[social auth] cart merge failed:', err?.message));
}

// Only allow same-site path redirects (no scheme, no protocol-relative) so a
// crafted ?redirect= can't bounce the freshly-authed user off-site.
function sanitiseRedirect(value) {
  if (!value || typeof value !== 'string') return '';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '';
  return value;
}

// Find the customer behind a verified provider identity, linking by email
// or creating a fresh customer when this is their first visit. Idempotent
// w.r.t. the backfilled CustomerIdentity rows.
async function upsertCustomerFromIdentity({ businessId, identity }) {
  const { provider, subject, email, name } = identity;

  const existing = await prisma.customerIdentity.findUnique({
    where: { businessId_provider_subject: { businessId, provider, subject } },
    include: { customer: { include: { business: { select: { name: true, defaultLanguage: true } } } } },
  });
  if (existing?.customer && !existing.customer.pendingDeletionAt) {
    await prisma.customerIdentity.update({
      where: { id: existing.id },
      data: { lastLoginAt: new Date(), email },
    });
    return { customer: existing.customer, created: false };
  }

  let customer = await prisma.customer.findUnique({
    where: { businessId_email: { businessId, email } },
    include: { business: { select: { name: true, defaultLanguage: true } } },
  });
  let created = false;

  if (!customer) {
    const randomPw = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    customer = await prisma.customer.create({
      data: {
        businessId,
        email,
        password: randomPw,
        name: name || email.split('@')[0],
        googleId: provider === 'google' ? subject : null,
        emailVerified: true,
        // Social-only: the password above is random — flag the account so the
        // portal never demands a "current password" they never set.
        hasPassword: false,
      },
      include: { business: { select: { name: true, defaultLanguage: true } } },
    });
    created = true;
  } else if (provider === 'google' && !customer.googleId) {
    // Keep the legacy column in sync for any code path still reading it.
    await prisma.customer.update({ where: { id: customer.id }, data: { googleId: subject } });
  }

  await prisma.customerIdentity.upsert({
    where: { customerId_provider: { customerId: customer.id, provider } },
    create: { businessId, customerId: customer.id, provider, subject, email, lastLoginAt: new Date() },
    update: { subject, email, lastLoginAt: new Date() },
  });

  return { customer, created };
}

function sendWelcome(customer, req) {
  try {
    sendCustomerWelcomeEmail(customer.email, customer.name, {
      businessName: customer.business?.name || 'the business',
      businessId: customer.businessId,
      customerId: customer.id,
      locale: resolveRecipientLocale({ business: customer.business, cookieLocale: req.cookies?.NEXT_LOCALE }),
    }).catch((e) => console.error('[social auth] welcome email failed:', e.message));
  } catch (e) {
    /* non-fatal */
  }
}

// ── Leg 1: verify + mint one-time code ──────────────────────────────
async function runStart(providerName, req, res) {
  const provider = getProvider(providerName);
  if (!provider) {
    return res.status(404).json({ message: `Unknown sign-in provider: ${providerName}` });
  }
  if (!provider.isConfigured()) {
    return res.status(503).json({
      message: `${provider.name} sign-in is not configured on the server`,
      code: 'PROVIDER_NOT_CONFIGURED',
    });
  }

  const { credential, host, redirect } = req.body || {};
  if (!credential || !host) {
    return res.status(400).json({ message: 'credential and host are required' });
  }

  const tenant = await resolveTenantByHost(host);
  if (!tenant) {
    return res.status(404).json({ message: `Business not found for host: ${host}` });
  }

  let identity;
  try {
    identity = await provider.verify(credential);
  } catch (e) {
    const status = e.code === 'PROVIDER_NOT_CONFIGURED' ? 503
      : e.code === 'NO_EMAIL' ? 400
      : 401;
    return res.status(status).json({ message: e.message || 'Sign-in verification failed' });
  }

  const { customer, created } = await upsertCustomerFromIdentity({
    businessId: tenant.businessId,
    identity,
  });
  if (created) sendWelcome(customer, req);
  fireClaim({ customerId: customer.id, businessId: tenant.businessId, email: customer.email });

  const code = await issueAuthCode({
    customerId: customer.id,
    businessId: tenant.businessId,
    returnHost: tenant.host,
  });

  const url = new URL(`https://${tenant.host}/auth/callback`);
  url.searchParams.set('code', code);
  const safeRedirect = sanitiseRedirect(redirect);
  if (safeRedirect) url.searchParams.set('redirect', safeRedirect);

  return res.json({ code, redirectUrl: url.toString() });
}

// ── Leg 2: consume code + set cookie on the tenant host ─────────────
async function socialExchange(req, res) {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ message: 'code is required' });

  const entry = await consumeAuthCode(code);
  if (!entry) return res.status(401).json({ message: 'Invalid or expired code' });

  const customer = await prisma.customer.findUnique({
    where: { id: entry.customerId },
    select: { id: true, email: true, name: true, businessId: true, pendingDeletionAt: true, isActive: true, anonymisedAt: true },
  });
  if (!customer) return res.status(404).json({ message: 'Customer not found' });
  // Same deactivation gate as email/password login — a deactivated or purged
  // customer must not be able to re-authenticate via the social code path.
  if (!customer.isActive || customer.anonymisedAt) {
    return res.status(403).json({ message: 'This account is no longer active.' });
  }

  setCustomerTokenCookie(res, { id: customer.id, businessId: customer.businessId }, req);
  fireClaim({ customerId: customer.id, businessId: customer.businessId, email: customer.email });
  fireCartMerge({ customerId: customer.id, businessId: customer.businessId, sessionId: req.headers['x-cart-session'] });

  return res.json({
    customer: {
      id: customer.id,
      email: customer.email,
      name: customer.name,
      businessId: customer.businessId,
    },
  });
}

function socialStart(req, res) {
  return runStart(req.params.provider, req, res);
}

// ── Legacy aliases (kept so older deployed frontends keep working) ──
function googleAuthCode(req, res) {
  return runStart('google', req, res);
}
const exchangeCode = socialExchange;

// Legacy direct flow: SDK loaded on the tenant host itself (deprecated —
// only works where the tenant host is a registered Google JS origin). Sets
// the cookie immediately, no code hop. Host comes from the tenant header.
async function googleAuth(req, res) {
  const provider = getProvider('google');
  if (!provider || !provider.isConfigured()) {
    return res.status(503).json({ message: 'Google sign-in is not configured on the server', code: 'PROVIDER_NOT_CONFIGURED' });
  }
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ message: 'Google credential token is required' });

  const hostHeader = (req.get('X-Tenant-Host') || req.get('X-Forwarded-Host') || req.get('Host') || '');
  const tenant = await resolveTenantByHost(hostHeader);
  if (!tenant) {
    return res.status(400).json({ message: 'Could not determine which business you are signing into' });
  }

  let identity;
  try {
    identity = await provider.verify(credential);
  } catch (e) {
    const status = e.code === 'PROVIDER_NOT_CONFIGURED' ? 503 : e.code === 'NO_EMAIL' ? 400 : 401;
    return res.status(status).json({ message: e.message || 'Invalid Google credential' });
  }

  const { customer, created } = await upsertCustomerFromIdentity({
    businessId: tenant.businessId,
    identity,
  });
  // Don't let a deactivated / purged customer re-authenticate via Google.
  if (!created && (customer.isActive === false || customer.anonymisedAt)) {
    return res.status(403).json({ message: 'This account is no longer active.' });
  }
  if (created) sendWelcome(customer, req);

  setCustomerTokenCookie(res, { id: customer.id, businessId: tenant.businessId }, req);
  fireClaim({ customerId: customer.id, businessId: tenant.businessId, email: customer.email });
  fireCartMerge({ customerId: customer.id, businessId: tenant.businessId, sessionId: req.headers['x-cart-session'] });
  return res.json({
    customer: {
      id: customer.id,
      email: customer.email,
      name: customer.name,
      businessId: customer.businessId,
    },
  });
}

module.exports = {
  socialStart,
  socialExchange,
  googleAuth,
  googleAuthCode,
  exchangeCode,
  // exported for unit tests / reuse
  upsertCustomerFromIdentity,
  sanitiseRedirect,
};
