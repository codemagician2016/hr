const crypto = require('crypto');

const PADDLE_API_VERSION = '1';

function getPaddleEnvironment() {
  return String(process.env.PADDLE_ENVIRONMENT || '').toLowerCase() === 'sandbox'
    ? 'sandbox'
    : 'live';
}

function getPaddleBaseUrl() {
  return getPaddleEnvironment() === 'sandbox'
    ? 'https://sandbox-api.paddle.com'
    : 'https://api.paddle.com';
}

function getPaddleApiKey() {
  return String(process.env.PADDLE_API_KEY || '').trim();
}

function getPaddleWebhookSecret() {
  return String(process.env.PADDLE_WEBHOOK_SECRET || '').trim();
}

function getPaddleWebhookToleranceSeconds() {
  const parsed = Number.parseInt(process.env.PADDLE_WEBHOOK_TOLERANCE_SECONDS || '300', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 300;
  return Math.min(parsed, 900);
}

function isPaddleConfigured() {
  return Boolean(getPaddleApiKey());
}

async function paddleRequestJson(method, path, body, query) {
  const apiKey = getPaddleApiKey();
  if (!apiKey) {
    const err = new Error('Paddle is not configured on the backend.');
    err.status = 500;
    throw err;
  }

  const url = new URL(path, `${getPaddleBaseUrl()}/`);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value == null || value === '') continue;
      url.searchParams.set(key, value);
    }
  }

  // Hard timeout so a slow/hanging Paddle API can never freeze a page that loads
  // billing data on render (Billing & Plan loads transactions + the subscription).
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Paddle-Version': PADDLE_API_VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      const e = new Error('Paddle request timed out');
      e.statusCode = 504;
      throw e;
    }
    throw err;
  }
  clearTimeout(timer);

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const firstError = Array.isArray(json?.error?.errors) ? json.error.errors[0] : null;
    const err = new Error(
      firstError?.detail
      || json?.error?.detail
      || json?.error?.message
      || `Paddle request failed with ${res.status}`
    );
    err.status = res.status;
    err.code = firstError?.code || json?.error?.code || null;
    err.data = json;
    throw err;
  }

  return {
    data: json?.data ?? null,
    meta: json?.meta ?? null,
  };
}

async function paddleRequest(method, path, body, query) {
  const { data } = await paddleRequestJson(method, path, body, query);
  return data;
}

async function createPaddleCustomer(payload) {
  return paddleRequest('POST', '/customers', payload);
}

async function updatePaddleCustomer(customerId, payload) {
  return paddleRequest('PATCH', `/customers/${customerId}`, payload);
}

async function createPaddleCustomerAddress(customerId, payload) {
  return paddleRequest('POST', `/customers/${customerId}/addresses`, payload);
}

async function createPaddleCustomerBusiness(customerId, payload) {
  return paddleRequest('POST', `/customers/${customerId}/businesses`, payload);
}

async function createPaddleTransaction(payload) {
  return paddleRequest('POST', '/transactions', payload);
}

async function getPaddleSubscription(subscriptionId, query) {
  return paddleRequest('GET', `/subscriptions/${subscriptionId}`, undefined, query);
}

async function getPaddlePrice(priceId, query) {
  return paddleRequest('GET', `/prices/${priceId}`, undefined, query);
}

async function createPaddleDiscount(payload) {
  return paddleRequest('POST', '/discounts', payload);
}

async function getPaddleDiscount(discountId) {
  return paddleRequest('GET', `/discounts/${discountId}`);
}

async function listPaddleDiscounts(query = {}) {
  const { data, meta } = await paddleRequestJson('GET', '/discounts', undefined, query);
  return {
    data: Array.isArray(data) ? data : [],
    meta: meta || null,
  };
}

// Partial refund against a Paddle transaction by creating a refund Adjustment.
// Paddle requires per-line-item amounts; we fetch the transaction's line items
// and distribute the requested refund proportionally so a single arbitrary
// amountMinor maps to a valid adjustment payload. Caller passes `transactionId`
// (the Paddle txn id we stored as `paymentRef`), `amountMinor` (the refund
// amount in minor units of the order's currency), and an optional `reason`.
async function refundPaddleTransaction({ transactionId, amountMinor, reason = 'order_adjustment' } = {}) {
  if (!transactionId) throw new Error('refundPaddleTransaction: transactionId is required');
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) throw new Error('refundPaddleTransaction: amountMinor must be > 0');

  // Pull the transaction with item totals so we can build a partial Adjustment.
  const txn = await paddleRequest('GET', `/transactions/${transactionId}`);
  const items = Array.isArray(txn?.items) ? txn.items : [];
  if (!items.length) throw new Error('refundPaddleTransaction: transaction has no items to refund against');

  // Each item carries `id` (transaction-item id) + a `totals.total` in minor units (string).
  const itemTotals = items.map((it) => Number(it?.totals?.total || 0));
  const grandTotal = itemTotals.reduce((s, n) => s + n, 0);
  if (grandTotal <= 0) throw new Error('refundPaddleTransaction: transaction has no positive line totals');
  const refundAmount = Math.min(Math.round(amountMinor), grandTotal);

  // Distribute proportionally; assign rounding remainder to the last refundable line so the
  // sum matches refundAmount exactly (Paddle rejects mismatched item sums).
  const distributed = items.map((it, i) => {
    const share = grandTotal ? Math.floor((refundAmount * itemTotals[i]) / grandTotal) : 0;
    return { item_id: it.id, type: 'partial', amount: String(share) };
  });
  const allocated = distributed.reduce((s, x) => s + Number(x.amount), 0);
  const remainder = refundAmount - allocated;
  if (remainder !== 0) {
    // Find the last line with non-zero share and add the remainder there.
    for (let i = distributed.length - 1; i >= 0; i -= 1) {
      if (Number(distributed[i].amount) > 0) {
        distributed[i].amount = String(Number(distributed[i].amount) + remainder);
        break;
      }
    }
  }
  const refundItems = distributed.filter((x) => Number(x.amount) > 0);
  if (!refundItems.length) throw new Error('refundPaddleTransaction: refund distribution produced no line items');

  return paddleRequest('POST', '/adjustments', {
    action: 'refund',
    transaction_id: transactionId,
    reason,
    items: refundItems,
  });
}

async function updatePaddleSubscription(subscriptionId, payload) {
  return paddleRequest('PATCH', `/subscriptions/${subscriptionId}`, payload);
}

async function cancelPaddleSubscription(subscriptionId, payload = {}) {
  return paddleRequest('POST', `/subscriptions/${subscriptionId}/cancel`, payload);
}

async function listPaddleClientTokens() {
  return paddleRequest('GET', '/client-tokens', undefined, { status: 'active' });
}

async function listPaddleSubscriptionsForCustomer(customerId) {
  return paddleRequest('GET', '/subscriptions', undefined, {
    customer_id: customerId,
    status: 'active,trialing,past_due,paused',
  });
}

async function listPaddleTransactions(query = {}) {
  const { data, meta } = await paddleRequestJson('GET', '/transactions', undefined, query);
  return {
    data: Array.isArray(data) ? data : [],
    meta: meta || null,
  };
}

async function getPaddleTransaction(transactionId, query) {
  return paddleRequest('GET', `/transactions/${transactionId}`, undefined, query);
}

async function getPaddleTransactionInvoice(transactionId, disposition = 'inline') {
  return paddleRequest('GET', `/transactions/${transactionId}/invoice`, undefined, { disposition });
}

async function createPaddleCustomerPortalSession(customerId, payload = {}) {
  return paddleRequest('POST', `/customers/${customerId}/portal-sessions`, payload);
}

function parsePaddleSignatureHeader(header) {
  const out = { ts: null, signatures: [] };
  if (!header) return out;

  const parts = String(header).split(';').map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (!key || !value) continue;
    if (key === 'ts') out.ts = value;
    if (key === 'h1') out.signatures.push(value);
  }
  return out;
}

function verifyPaddleWebhookSignature({ rawBody, signatureHeader, secret, toleranceSeconds = 30 }) {
  if (!Buffer.isBuffer(rawBody)) {
    throw new Error('Paddle webhook body must be a raw Buffer.');
  }
  if (!signatureHeader || !secret) return false;

  const parsed = parsePaddleSignatureHeader(signatureHeader);
  if (!parsed.ts || parsed.signatures.length === 0) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(parsed.ts)) > toleranceSeconds) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parsed.ts}:${rawBody.toString('utf8')}`)
    .digest('hex');

  const expectedBuffer = Buffer.from(expected, 'hex');
  return parsed.signatures.some((signature) => {
    try {
      const actualBuffer = Buffer.from(signature, 'hex');
      return actualBuffer.length === expectedBuffer.length
        && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
    } catch {
      return false;
    }
  });
}

module.exports = {
  cancelPaddleSubscription,
  createPaddleCustomer,
  createPaddleCustomerAddress,
  createPaddleCustomerBusiness,
  createPaddleDiscount,
  createPaddleTransaction,
  getPaddleDiscount,
  getPaddleApiKey,
  getPaddleBaseUrl,
  getPaddleEnvironment,
  getPaddlePrice,
  getPaddleSubscription,
  getPaddleTransaction,
  getPaddleTransactionInvoice,
  getPaddleWebhookSecret,
  getPaddleWebhookToleranceSeconds,
  isPaddleConfigured,
  listPaddleTransactions,
  listPaddleClientTokens,
  listPaddleDiscounts,
  listPaddleSubscriptionsForCustomer,
  createPaddleCustomerPortalSession,
  parsePaddleSignatureHeader,
  refundPaddleTransaction,
  updatePaddleSubscription,
  updatePaddleCustomer,
  verifyPaddleWebhookSignature,
};
