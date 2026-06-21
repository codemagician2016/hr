// Stripe Connect helpers — global ECOMMERCE payment processing.
//
// Sitepresso = platform account. Tenants are Express Connected Accounts.
// Buyer payments are DIRECT CHARGES created ON the tenant's connected account
// (via the `Stripe-Account` header), so the TENANT is the merchant of record:
// their customer's money settles to the tenant, and the tenant owns refunds,
// disputes/chargebacks, and compliance. Sitepresso only takes
// `application_fee_amount` as platform commission and is NOT in the funds flow.
//
// Envvars: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
'use strict';

const crypto = require('crypto');

function isConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

function authHeader() {
  return { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` };
}

// Create a DIRECT charge ON the connected account — the tenant is the merchant
// of record (their customer's money + disputes/compliance are the tenant's).
// Sitepresso takes `application_fee_amount` and is never in the funds flow.
// The PaymentIntent is created on the connected account via the `Stripe-Account`
// header, so the storefront MUST confirm it with Stripe.js initialised
// `Stripe(publishableKey, { stripeAccount: connectedAccountId })`.
async function createDirectCharge({
  amountMinor,
  currency = 'usd',
  connectedAccountId,
  platformFeePct,
  metadata,
}) {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (!connectedAccountId) return { ok: false, reason: 'NO_CONNECTED_ACCOUNT' };

  const platformFeeMinor = Math.round(amountMinor * (Number(platformFeePct) || 0) / 100);

  const params = new URLSearchParams();
  params.append('amount', String(amountMinor));
  params.append('currency', currency.toLowerCase());
  // Omit the fee entirely when 0 — Stripe rejects application_fee_amount=0, and
  // 0% means pure pass-through (the tenant keeps 100%).
  if (platformFeeMinor > 0) params.append('application_fee_amount', String(platformFeeMinor));
  params.append('automatic_payment_methods[enabled]', 'true');
  if (metadata) {
    for (const [k, v] of Object.entries(metadata)) params.append(`metadata[${k}]`, String(v));
  }

  try {
    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        ...authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        // Creating the PI on the connected account = DIRECT charge (tenant = MoR).
        'Stripe-Account': connectedAccountId,
      },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: 'API_ERROR', message: data.error?.message || `HTTP ${res.status}` };
    return { ok: true, clientSecret: data.client_secret, paymentIntentId: data.id, connectedAccountId };
  } catch (err) {
    return { ok: false, reason: 'NETWORK', message: err.message };
  }
}

// Generate the Connected Account link the tenant uses to onboard.
// Requests `transfers` + `card_payments` capabilities at creation so once
// the seller completes KYC, our split PaymentIntents work without an extra
// capability-request round-trip.
async function createConnectedAccount({ businessEmail, businessName, country = 'US' }) {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  const params = new URLSearchParams();
  params.append('type', 'express');
  params.append('country', country);
  params.append('email', businessEmail);
  params.append('business_profile[name]', businessName || 'Sitepresso seller');
  params.append('capabilities[transfers][requested]', 'true');
  params.append('capabilities[card_payments][requested]', 'true');
  try {
    const res = await fetch('https://api.stripe.com/v1/accounts', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: 'API_ERROR', message: data.error?.message || `HTTP ${res.status}` };
    return { ok: true, accountId: data.id };
  } catch (err) {
    return { ok: false, reason: 'NETWORK', message: err.message };
  }
}

async function createOnboardingLink({ accountId, returnUrl }) {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  const params = new URLSearchParams();
  params.append('account', accountId);
  params.append('refresh_url', returnUrl);
  params.append('return_url', returnUrl);
  params.append('type', 'account_onboarding');
  try {
    const res = await fetch('https://api.stripe.com/v1/account_links', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: 'API_ERROR', message: data.error?.message || `HTTP ${res.status}` };
    return { ok: true, url: data.url };
  } catch (err) {
    return { ok: false, reason: 'NETWORK', message: err.message };
  }
}

function connectedAccountStatus(account) {
  if (!account) return 'PENDING';
  const disabledReason = String(account.requirements?.disabled_reason || '');
  if (/rejected|listed|fraud|terms_of_service/i.test(disabledReason)) return 'SUSPENDED';
  if (account.charges_enabled && account.payouts_enabled) return 'ACTIVE';
  return 'PENDING';
}

async function fetchConnectedAccount(accountId) {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (!accountId) return { ok: false, reason: 'NO_CONNECTED_ACCOUNT' };
  try {
    const res = await fetch(`https://api.stripe.com/v1/accounts/${encodeURIComponent(accountId)}`, {
      method: 'GET',
      headers: authHeader(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: 'API_ERROR', message: data.error?.message || `HTTP ${res.status}` };
    return {
      ok: true,
      accountId: data.id || accountId,
      status: connectedAccountStatus(data),
      chargesEnabled: Boolean(data.charges_enabled),
      payoutsEnabled: Boolean(data.payouts_enabled),
      detailsSubmitted: Boolean(data.details_submitted),
      disabledReason: data.requirements?.disabled_reason || null,
      requirements: data.requirements || null,
      data,
    };
  } catch (err) {
    return { ok: false, reason: 'NETWORK', message: err.message };
  }
}

// Refund (full or partial) a direct charge that was created ON the connected
// account. Because the original charge used the `Stripe-Account` header, the
// refund must too. amountMinor omitted/0 = full refund. Returns { ok, refundId }
// or { ok:false, reason, message }.
async function refundDirectCharge({ paymentIntentId, amountMinor, connectedAccountId }) {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (!paymentIntentId) return { ok: false, reason: 'NO_PAYMENT' };
  if (!connectedAccountId) return { ok: false, reason: 'NO_CONNECTED_ACCOUNT' };
  const params = new URLSearchParams();
  params.append('payment_intent', paymentIntentId);
  if (Number(amountMinor) > 0) params.append('amount', String(Math.round(amountMinor)));
  try {
    const res = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: {
        ...authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Account': connectedAccountId,
      },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: 'API_ERROR', message: data.error?.message || `HTTP ${res.status}` };
    return { ok: true, refundId: data.id };
  } catch (err) {
    return { ok: false, reason: 'NETWORK', message: err.message };
  }
}

// Verify a Stripe webhook against an EXPLICIT secret (so BYO tenants verify with
// their OWN endpoint secret). Header format: t=<ts>,v1=<sig>[,v1=<sig>…] — collect
// the timestamp and ALL v1 signatures (Stripe sends several during a rotation).
// Anti-replay: the signed timestamp is checked against a tolerance window.
function verifyWebhookSignatureWithSecret({ body, signatureHeader, secret, toleranceSec = 300, nowMs = Date.now() }) {
  if (!secret) return false;
  let timestamp = null;
  const signatures = [];
  for (const part of String(signatureHeader || '').split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const expectedBuf = Buffer.from(expected);
  return signatures.some((sig) => {
    if (sig.length !== expected.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(sig), expectedBuf); } catch { return false; }
  });
}

// Platform-secret verify for the Connect/orders endpoint (separate signing
// secret from the subscriptions webhook). Prefer STRIPE_CONNECT_WEBHOOK_SECRET.
function verifyWebhookSignature({ body, signatureHeader, toleranceSec = 300, nowMs = Date.now() }) {
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
  return verifyWebhookSignatureWithSecret({ body, signatureHeader, secret, toleranceSec, nowMs });
}

// ─── BYO Stripe — the tenant's OWN Stripe account (no Connect) ───────────────
// Validate a tenant's secret key by hitting a cheap authenticated endpoint.
async function validateSecretKey(secretKey) {
  const sk = String(secretKey || '').trim();
  if (!/^sk_(test|live)_/.test(sk)) {
    return { ok: false, message: 'That is not a Stripe secret key (it should start with sk_test_ or sk_live_).' };
  }
  try {
    const res = await fetch('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${sk}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, message: data.error?.message || `Stripe rejected the key (HTTP ${res.status}).` };
    return { ok: true, mode: sk.startsWith('sk_live_') ? 'live' : 'test' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// Create a PaymentIntent on the TENANT's own Stripe account (BYO). No
// Stripe-Account header, no application_fee — the tenant keeps 100% and is the
// sole merchant of record. The storefront confirms with the tenant's publishable
// key (stored alongside the secret).
async function createPaymentIntentWithKey({ secretKey, amountMinor, currency = 'usd', metadata }) {
  const sk = String(secretKey || '').trim();
  if (!sk) return { ok: false, reason: 'NO_KEY' };
  const params = new URLSearchParams();
  params.append('amount', String(amountMinor));
  params.append('currency', String(currency).toLowerCase());
  params.append('automatic_payment_methods[enabled]', 'true');
  if (metadata) for (const [k, v] of Object.entries(metadata)) params.append(`metadata[${k}]`, String(v));
  try {
    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sk}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: 'API_ERROR', message: data.error?.message || `HTTP ${res.status}` };
    return { ok: true, clientSecret: data.client_secret, paymentIntentId: data.id };
  } catch (err) {
    return { ok: false, reason: 'NETWORK', message: err.message };
  }
}

// Refund a BYO charge on the TENANT's own Stripe account (their secret key, no
// Stripe-Account header). amountMinor omitted/0 = full refund.
async function refundWithKey({ secretKey, paymentIntentId, amountMinor }) {
  const sk = String(secretKey || '').trim();
  if (!sk) return { ok: false, reason: 'NO_KEY' };
  if (!paymentIntentId) return { ok: false, reason: 'NO_PAYMENT' };
  const params = new URLSearchParams();
  params.append('payment_intent', paymentIntentId);
  if (Number(amountMinor) > 0) params.append('amount', String(Math.round(amountMinor)));
  try {
    const res = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sk}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: 'API_ERROR', message: data.error?.message || `HTTP ${res.status}` };
    return { ok: true, refundId: data.id };
  } catch (err) {
    return { ok: false, reason: 'NETWORK', message: err.message };
  }
}

module.exports = {
  isConfigured,
  connectedAccountStatus,
  createDirectCharge,
  refundDirectCharge,
  createConnectedAccount,
  createOnboardingLink,
  fetchConnectedAccount,
  verifyWebhookSignature,
  verifyWebhookSignatureWithSecret,
  validateSecretKey,
  createPaymentIntentWithKey,
  refundWithKey,
};
