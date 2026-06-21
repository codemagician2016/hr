// Razorpay Route helpers — IN-only ECOMMERCE payment processing.
//
// Sitepresso operates as the principal Razorpay account. Tenants are
// Linked Accounts onboarded under Sitepresso. Each payment uses the
// `transfers[]` parameter to split:
//   95-97%  → tenant's linked account → settles to seller's bank
//   1-2.5% → Sitepresso (platform commission) → our bank
//   ~2%    → Razorpay (gateway fee, off-the-top)
//
// Envvars required at runtime:
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET — platform credentials
//   RAZORPAY_WEBHOOK_SECRET — for webhook signature verification
'use strict';

const crypto = require('crypto');

function isConfigured() {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

function authHeader() {
  const tok = Buffer
    .from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`)
    .toString('base64');
  return { Authorization: `Basic ${tok}` };
}

// Create a Razorpay Order with split-payment transfers[]. Returns
// { ok, orderId, amount, currency } or { ok:false, reason, message }.
async function createOrderWithSplit({
  amountMinor,
  currency = 'INR',
  receipt,
  notes,
  linkedAccountId,
  platformFeePct,
}) {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (!linkedAccountId) return { ok: false, reason: 'NO_LINKED_ACCOUNT' };

  // Compute split: platformFeePct% goes to Sitepresso (no transfer needed —
  // it's the default), the rest transfers to the linked account.
  const platformFeeMinor = Math.round(amountMinor * (Number(platformFeePct) || 0) / 100);
  const sellerAmountMinor = amountMinor - platformFeeMinor;
  const transfers = [{
    account: linkedAccountId,
    amount: sellerAmountMinor,
    currency,
    notes: { source: 'sitepresso' },
    on_hold: 0,
  }];

  try {
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amountMinor,
        currency,
        receipt: receipt?.slice(0, 40),
        notes,
        transfers,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, reason: 'API_ERROR', message: data.error?.description || `HTTP ${res.status}` };
    }
    return { ok: true, orderId: data.id, amount: data.amount, currency: data.currency };
  } catch (err) {
    return { ok: false, reason: 'NETWORK', message: err.message };
  }
}

// Verify Razorpay webhook signature.
function verifyWebhookSignature({ body, signatureHeader }) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');
  if (!signatureHeader || signatureHeader.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
}

// Verify a payment-success signature returned by Razorpay's frontend
// checkout (razorpay_signature). Used after the buyer completes payment.
function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!isConfigured()) return false;
  return verifyPaymentSignatureWithSecret({
    orderId,
    paymentId,
    signature,
    secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

function verifyPaymentSignatureWithSecret({ orderId, paymentId, signature, secret }) {
  if (!secret) return false;
  const body = `${orderId}|${paymentId}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  if (!signature || signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ─── Route LINKED ACCOUNT onboarding (v2 Accounts API) ──────────────────────
// Automated seller onboarding: Sitepresso creates the seller's linked sub-
// account, requests the 'route' product (KYC), and tracks activation — so the
// gateway handles compliance and the tenant can start accepting buyer payments.
async function v2Fetch(method, path, body) {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutMs = Math.max(1000, Number(process.env.RAZORPAY_API_TIMEOUT_MS || 20000));
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`https://api.razorpay.com/v2${path}`, {
      method,
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: 'API_ERROR', message: data.error?.description || `HTTP ${res.status}`, data };
    return { ok: true, data };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { ok: false, reason: 'TIMEOUT', message: 'Razorpay did not respond in time. Please try again.' };
    }
    return { ok: false, reason: 'NETWORK', message: err.message };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// Create a Route linked account (the seller's sub-merchant under Sitepresso).
async function createLinkedAccount(payload) {
  const r = await v2Fetch('POST', '/accounts', { type: 'route', ...payload });
  if (!r.ok) return r;
  return { ok: true, accountId: r.data.id, status: r.data.status, data: r.data };
}

// Request the 'route' product config on a linked account → KYC activation
// status + outstanding requirements the seller still needs to provide.
async function requestRouteProduct(accountId) {
  const r = await v2Fetch('POST', `/accounts/${accountId}/products`, { product_name: 'route', tnc_accepted: true });
  if (!r.ok) return r;
  return productResult(r.data);
}

async function createStakeholder(accountId, payload) {
  const r = await v2Fetch('POST', `/accounts/${accountId}/stakeholders`, payload);
  if (!r.ok) return r;
  return { ok: true, stakeholderId: r.data.id, data: r.data };
}

async function updateRouteProduct(accountId, productId, { settlements }) {
  const r = await v2Fetch('PATCH', `/accounts/${accountId}/products/${productId}`, {
    settlements,
    tnc_accepted: true,
  });
  if (!r.ok) return r;
  return productResult(r.data);
}

async function fetchRouteProduct(accountId, productId) {
  const r = await v2Fetch('GET', `/accounts/${accountId}/products/${productId}`);
  if (!r.ok) return r;
  return productResult(r.data);
}

function productResult(data = {}) {
  return {
    ok: true,
    productId: data.id,
    activationStatus: data.activation_status,
    requirements: Array.isArray(data.requirements) ? data.requirements : [],
    activeConfiguration: data.active_configuration || null,
    requestedConfiguration: data.requested_configuration || null,
    data,
  };
}

function itemsFrom(data = {}) {
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data)) return data;
  return [];
}

async function listRouteProducts(accountId) {
  const r = await v2Fetch('GET', `/accounts/${accountId}/products`);
  if (!r.ok) return r;
  return {
    ok: true,
    products: itemsFrom(r.data)
      .filter((item) => item.product_name === 'route')
      .map(productResult),
    data: r.data,
  };
}

async function listStakeholders(accountId) {
  const r = await v2Fetch('GET', `/accounts/${accountId}/stakeholders`);
  if (!r.ok) return r;
  return { ok: true, stakeholders: itemsFrom(r.data), data: r.data };
}

async function fetchAccount(accountId) {
  const r = await v2Fetch('GET', `/accounts/${accountId}`);
  if (!r.ok) return r;
  return { ok: true, status: r.data.status, data: r.data };
}

// ─── AGGREGATOR PARTNER — act ON BEHALF OF a sub-merchant account ────────────
// We onboard the tenant as a sub-merchant (createLinkedAccount → acc_xxx) and
// create the buyer's order ON their account using OUR partner key + the
// X-Razorpay-Account header. Money settles to the sub-merchant; we (partner)
// earn Razorpay's commission — we never touch the funds and take no tenant cut.
// Requires the platform key to be a Razorpay PARTNER credential.
async function createOrderOnBehalf({ subMerchantAccountId, amountMinor, currency = 'INR', receipt, notes }) {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (!subMerchantAccountId) return { ok: false, reason: 'NO_SUBMERCHANT' };
  try {
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json', 'X-Razorpay-Account': subMerchantAccountId },
      body: JSON.stringify({ amount: amountMinor, currency, receipt: receipt?.slice(0, 40), notes }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: 'API_ERROR', message: data.error?.description || `HTTP ${res.status}` };
    return { ok: true, orderId: data.id, amount: data.amount, currency: data.currency };
  } catch (err) { return { ok: false, reason: 'NETWORK', message: err.message }; }
}

// Refund (full or partial) a captured Partner/Route payment. Uses the platform
// partner key plus X-Razorpay-Account for the sub-merchant. amountMinor omitted
// or 0 = full refund. Returns { ok, refundId } or { ok:false, ... }.
async function refundPayment({ paymentId, amountMinor, subMerchantAccountId }) {
  if (!paymentId) return { ok: false, reason: 'NO_PAYMENT' };
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  const headers = {
    ...authHeader(),
    'Content-Type': 'application/json',
    ...(subMerchantAccountId ? { 'X-Razorpay-Account': subMerchantAccountId } : {}),
  };
  try {
    const res = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refunds`, {
      method: 'POST',
      headers,
      body: JSON.stringify(Number(amountMinor) > 0 ? { amount: Math.round(amountMinor) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: 'API_ERROR', message: data.error?.description || `HTTP ${res.status}` };
    return { ok: true, refundId: data.id };
  } catch (err) {
    return { ok: false, reason: 'NETWORK', message: err.message };
  }
}

// ─── BYO ("Bring Your Own") keys — India tenant connects their OWN Razorpay ───
// account (the Shopify-India model). India's RBI Payment-Aggregator rules mean a
// platform cannot legally collect/route buyer funds on a merchant's behalf
// without a PA licence, so each India tenant brings their own Razorpay account
// (which Razorpay KYC'd directly). We create the order and verify signatures
// with the TENANT's own key/secret; funds settle to the tenant, and Sitepresso
// is never in the money flow. The platform partner key is NOT used here.
function basicAuth(keyId, keySecret) {
  return { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` };
}

// Confirm a tenant's key/secret actually authenticate before we store them.
async function validateKeys({ keyId, keySecret }) {
  if (!keyId || !keySecret) return { ok: false, reason: 'NO_KEYS', message: 'Enter both the Key ID and the Key Secret.' };
  try {
    const res = await fetch('https://api.razorpay.com/v1/payments?count=1', { method: 'GET', headers: { ...basicAuth(keyId, keySecret) } });
    if (res.status === 401) return { ok: false, reason: 'UNAUTHORIZED', message: 'These Razorpay keys did not authenticate — re-copy them from your Razorpay dashboard (Account & Settings → API Keys).' };
    if (!res.ok) return { ok: false, reason: 'API_ERROR', message: `Razorpay returned HTTP ${res.status}` };
    return { ok: true, mode: String(keyId).startsWith('rzp_test_') ? 'test' : 'live' };
  } catch (err) {
    return { ok: false, reason: 'NETWORK', message: err.message };
  }
}

// Create a buyer order ON the tenant's own account using the tenant's keys.
async function createOrderWithKeys({ keyId, keySecret, amountMinor, currency = 'INR', receipt, notes }) {
  if (!keyId || !keySecret) return { ok: false, reason: 'NO_KEYS' };
  try {
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { ...basicAuth(keyId, keySecret), 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountMinor, currency, receipt: receipt?.slice(0, 40), notes }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: 'API_ERROR', message: data.error?.description || `HTTP ${res.status}` };
    return { ok: true, orderId: data.id, amount: data.amount, currency: data.currency };
  } catch (err) {
    return { ok: false, reason: 'NETWORK', message: err.message };
  }
}

// Verify a webhook HMAC against a SPECIFIC secret (a BYO tenant's own webhook
// secret) rather than the platform env secret — each tenant configures their own.
function verifyWebhookSignatureWithSecret({ body, signatureHeader, secret }) {
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (!signatureHeader || signatureHeader.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
}

module.exports = {
  isConfigured,
  refundPayment,
  createOrderWithSplit,
  verifyWebhookSignature,
  verifyWebhookSignatureWithSecret,
  verifyPaymentSignature,
  verifyPaymentSignatureWithSecret,
  validateKeys,
  createOrderWithKeys,
  createLinkedAccount,
  createStakeholder,
  listStakeholders,
  requestRouteProduct,
  updateRouteProduct,
  fetchRouteProduct,
  listRouteProducts,
  fetchAccount,
  createOrderOnBehalf,
};
