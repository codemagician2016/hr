//
// razorpayGateway.js — Razorpay adapter for SUBSCRIPTION billing (India / INR,
// UPI Autopay). The Razorpay twin of stripeGateway.js.
//
// Uses the Razorpay Subscriptions API (Plans + Subscriptions). Checkout returns
// the subscription's hosted `short_url` (UPI Autopay / card mandate auth page),
// mirroring Stripe's hosted Checkout redirect. Lifecycle is driven by webhooks
// (subscription.activated/charged/pending/halted/cancelled/...), verified by
// HMAC-SHA256 of the raw body against RAZORPAY_WEBHOOK_SECRET.
//
// Razorpay is NOT a Merchant of Record — Sitepresso owns India GST.
//
// Config: RAZORPAY_KEY_ID=rzp_test_…, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
//
// NOTE: ecommerce ORDER payments use a separate helper (razorpayRoute.js, Route
// split-transfers). This file is ONLY plan subscriptions.
//
const crypto = require('crypto');
const { PaymentGateway } = require('./PaymentGateway');

const API = 'https://api.razorpay.com/v1';

function authHeader() {
  const tok = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  return { Authorization: `Basic ${tok}` };
}

async function rzpFetch(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.description || `Razorpay HTTP ${res.status}`);
    err.status = res.status;
    err.razorpay = data?.error || null;
    throw err;
  }
  return data;
}

// Razorpay subscription status → internal SubscriptionStatus.
function mapRazorpayStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'authenticated': return 'TRIALING'; // mandate set, awaiting first charge
    case 'active': return 'ACTIVE';
    case 'pending': return 'PAST_DUE'; // a charge failed; retrying
    case 'halted': return 'PAST_DUE'; // retries exhausted (grace then downgrade)
    case 'paused': return 'PAUSED';
    case 'cancelled': return 'CANCELLED';
    case 'completed': return 'CANCELLED'; // all cycles done → downgrade to free
    case 'expired': return 'CANCELLED';
    default: return null; // 'created' → not entitling yet
  }
}

class RazorpayGateway extends PaymentGateway {
  constructor() { super('RAZORPAY'); }

  isConfigured() {
    return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  }

  environment() {
    return String(process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_test_') ? 'test' : 'live';
  }

  // Create a Razorpay Plan (used by the catalog setup script).
  async createPlan({ name, period, interval = 1, amountMinor, currency = 'INR', description }) {
    return rzpFetch('POST', '/plans', {
      period, // 'monthly' | 'yearly'
      interval,
      item: { name, amount: amountMinor, currency, description: description || name },
    });
  }

  // Create a subscription + return its hosted auth URL (short_url).
  async createSubscriptionCheckout({
    planRef, totalCount = 120, customerEmail = null, customerName = null, customerContact = null,
    metadata = {}, businessId = null, trialDays = null,
  }) {
    if (!planRef) throw new Error('Razorpay checkout requires a planRef (Razorpay plan id).');
    const parsedTrialDays = Number.parseInt(trialDays, 10);
    const startAt = Number.isFinite(parsedTrialDays) && parsedTrialDays > 0
      ? Math.floor((Date.now() + parsedTrialDays * 24 * 60 * 60 * 1000) / 1000)
      : null;
    const sub = await rzpFetch('POST', '/subscriptions', {
      plan_id: planRef,
      total_count: totalCount, // max billing cycles (monthly → 120 = 10y; renew before end)
      customer_notify: 1,
      quantity: 1,
      ...(startAt ? { start_at: startAt } : {}),
      notes: { ...metadata, businessId: businessId || metadata.businessId || '' },
      ...(customerEmail || customerName || customerContact
        ? { notify_info: { notify_email: customerEmail || undefined, notify_phone: customerContact || undefined } }
        : {}),
    });
    return { url: sub.short_url, reference: sub.id };
  }

  async getSubscription(subscriptionId) {
    return rzpFetch('GET', `/subscriptions/${subscriptionId}`);
  }

  // Fetch a single payment (used to read token_id off a mandate-auth payment).
  async getPayment(paymentId) {
    return rzpFetch('GET', `/payments/${paymentId}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CHARGE-AT-WILL (token/mandate) — register a UPI Autopay / card mandate ONCE
  // with a high max_amount, then charge the EXACT amount each cycle ourselves.
  // This sidesteps Razorpay's "can't update a UPI Subscription's plan in place"
  // limitation: plan up/downgrades become a simple amount change, no re-mandate.
  //
  // ⚠️ These methods follow Razorpay's documented Recurring Payments (S2S) API
  //    but MUST be verified end-to-end in the Razorpay SANDBOX (test mandate
  //    auth → first charge → recurring charge → pre-debit notification) before
  //    the self-billing cron is enabled against real money. The exact param
  //    names for /payments/create/recurring and the UPI pre-debit notification
  //    flow are the ones to confirm against the live dashboard/docs.
  // ───────────────────────────────────────────────────────────────────────────

  // Create (or reuse) a Razorpay customer to anchor the mandate token.
  async createCustomer({ name, email, contact, notes } = {}) {
    return rzpFetch('POST', '/customers', {
      name: name || undefined,
      email: email || undefined,
      contact: contact || undefined,
      fail_existing: 0, // return the existing customer instead of erroring
      ...(notes ? { notes } : {}),
    });
  }

  // Authorization order: the FIRST transaction that registers the mandate token.
  // `maxAmountMinor` is the mandate ceiling (headroom for the top plan); the
  // frequency 'as_presented' lets us charge a variable amount each cycle.
  // The frontend completes this via Checkout.js with recurring:1; the resulting
  // payment carries the reusable `token_id`.
  async createAuthOrder({
    amountMinor, currency = 'INR', method = 'upi', customerId,
    maxAmountMinor, expireAt, frequency = 'as_presented', notes, receipt,
  } = {}) {
    if (!customerId) throw new Error('createAuthOrder requires a customerId.');
    if (!(amountMinor >= 0)) throw new Error('createAuthOrder requires amountMinor.');
    return rzpFetch('POST', '/orders', {
      amount: amountMinor,
      currency,
      method, // 'upi' | 'card' | 'emandate'
      customer_id: customerId,
      payment_capture: true,
      ...(receipt ? { receipt } : {}),
      token: {
        max_amount: maxAmountMinor,
        ...(expireAt ? { expire_at: expireAt } : {}),
        frequency, // 'as_presented' = we present a variable amount each cycle
        ...(notes ? { notes } : {}),
      },
      ...(notes ? { notes } : {}),
    });
  }

  // Subsequent (recurring) charge against a saved token, for the EXACT amount.
  // Two steps: an order to bind the amount, then the server-to-server recurring
  // payment. `receipt`/order idempotency MUST be unique per (businessId, cycle)
  // so a retry can't double-debit.
  async chargeToken({
    customerId, tokenId, amountMinor, currency = 'INR',
    email, contact, receipt, description, notes,
  } = {}) {
    if (!customerId || !tokenId) throw new Error('chargeToken requires customerId and tokenId.');
    if (!(amountMinor > 0)) throw new Error('chargeToken requires a positive amountMinor.');
    const order = await rzpFetch('POST', '/orders', {
      amount: amountMinor,
      currency,
      customer_id: customerId,
      payment_capture: true,
      ...(receipt ? { receipt } : {}),
      ...(notes ? { notes } : {}),
    });
    const payment = await rzpFetch('POST', '/payments/create/recurring', {
      email: email || undefined,
      contact: contact || undefined,
      amount: amountMinor,
      currency,
      order_id: order.id,
      customer_id: customerId,
      token: tokenId,
      recurring: '1',
      description: description || undefined,
      ...(notes ? { notes } : {}),
    });
    return { order, payment };
  }

  // Mandate (token) state — used by reconcile to confirm/cancel/pause status.
  async fetchToken({ customerId, tokenId } = {}) {
    if (!customerId || !tokenId) throw new Error('fetchToken requires customerId and tokenId.');
    return rzpFetch('GET', `/customers/${customerId}/tokens/${tokenId}`);
  }

  async cancelToken({ customerId, tokenId } = {}) {
    if (!customerId || !tokenId) throw new Error('cancelToken requires customerId and tokenId.');
    return rzpFetch('DELETE', `/customers/${customerId}/tokens/${tokenId}`);
  }

  // Fetch a Plan so Publish can decide reuse-vs-recreate (Razorpay plans are
  // immutable — a price change means a NEW plan).
  async getPlan(planId) {
    return rzpFetch('GET', `/plans/${planId}`);
  }

  async updateSubscription(subscriptionRef, {
    planRef,
    quantity = 1,
    remainingCount = null,
    scheduleChangeAt = 'now',
    customerNotify = true,
  } = {}) {
    if (!subscriptionRef) throw new Error('updateSubscription requires a Razorpay subscription id.');
    if (!planRef) throw new Error('Razorpay subscription update requires a planRef.');
    return rzpFetch('PATCH', `/subscriptions/${subscriptionRef}`, {
      plan_id: planRef,
      quantity,
      schedule_change_at: scheduleChangeAt === 'cycle_end' ? 'cycle_end' : 'now',
      customer_notify: Boolean(customerNotify),
      ...(Number.isFinite(remainingCount) && remainingCount > 0 ? { remaining_count: remainingCount } : {}),
    });
  }

  verifyWebhook({ rawBody, signatureHeader }) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      const err = new Error('RAZORPAY_WEBHOOK_SECRET is not configured.');
      err.status = 500;
      throw err;
    }
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const ok = signatureHeader
      && signatureHeader.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
    if (!ok) {
      const err = new Error('Invalid Razorpay signature.');
      err.status = 400;
      throw err;
    }
    return JSON.parse(body);
  }

  normalizeEvent(event) {
    const type = String(event?.event || '');
    const sub = event?.payload?.subscription?.entity || {};
    const payment = event?.payload?.payment?.entity || null;
    const base = { gateway: 'RAZORPAY', rawType: type, metadata: sub.notes || {} };

    if (type.startsWith('subscription.')) {
      return {
        ...base,
        kind: 'subscription_change',
        internalStatus: mapRazorpayStatus(sub.status),
        gatewayCustomerId: sub.customer_id || null,
        gatewaySubscriptionId: sub.id || null,
        gatewayTransactionId: payment?.id || null,
        priceRef: sub.plan_id || null,
        currency: String(payment?.currency || 'INR').toUpperCase(),
        amountMinor: Number.isFinite(payment?.amount) ? payment.amount : null,
        currentPeriodEnd: sub.current_end ? new Date(sub.current_end * 1000) : null,
      };
    }
    if (type === 'payment.failed') {
      return {
        ...base,
        kind: 'payment_failed',
        internalStatus: null,
        gatewayCustomerId: payment?.customer_id || null,
        gatewaySubscriptionId: payment?.subscription_id || sub.id || null,
        gatewayTransactionId: payment?.id || null,
        priceRef: sub.plan_id || null,
        currency: String(payment?.currency || 'INR').toUpperCase(),
        amountMinor: Number.isFinite(payment?.amount) ? payment.amount : null,
        currentPeriodEnd: null,
      };
    }
    if (type.startsWith('refund.')) {
      const refund = event?.payload?.refund?.entity || {};
      return {
        ...base,
        kind: 'refund',
        internalStatus: null,
        gatewayCustomerId: null,
        gatewaySubscriptionId: null,
        // Key on the REFUND id (rfnd_…) so multiple partial refunds of the same
        // payment each get a distinct ledger row; keep the payment id for linkage.
        gatewayTransactionId: refund.id || refund.payment_id || null,
        gatewayPaymentId: refund.payment_id || null,
        priceRef: null,
        currency: String(refund.currency || 'INR').toUpperCase(),
        amountMinor: Number.isFinite(refund.amount) ? refund.amount : null,
        currentPeriodEnd: null,
        metadata: refund.notes || {},
      };
    }
    return { ...base, kind: 'ignored', internalStatus: null };
  }

  async cancelSubscription(subscriptionRef, { immediately = false } = {}) {
    if (!subscriptionRef) throw new Error('cancelSubscription requires a Razorpay subscription id.');
    return rzpFetch('POST', `/subscriptions/${subscriptionRef}/cancel`, { cancel_at_cycle_end: immediately ? 0 : 1 });
  }

  async refund({ paymentRef, amountMinor = null }) {
    if (!paymentRef) throw new Error('refund requires a Razorpay payment id.');
    return rzpFetch('POST', `/payments/${paymentRef}/refund`, amountMinor != null ? { amount: amountMinor } : {});
  }
}

module.exports = { RazorpayGateway, mapRazorpayStatus };
