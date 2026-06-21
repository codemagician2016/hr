//
// stripeGateway.js — Stripe Billing adapter for New Zealand subscriptions.
//
// Mirrors the Paddle integration's responsibilities but for Stripe Billing:
//   * hosted subscription Checkout Sessions
//   * webhook signature verification (stripe.webhooks.constructEvent)
//   * normalization of Stripe events into the app's gateway-agnostic shape
//   * cancel + refund
//
// Stripe is NOT a Merchant of Record. Sitepresso is the merchant for NZ
// subscription billing; Paddle remains MoR for countries routed to Paddle.
//
// Config (sandbox): STRIPE_SECRET_KEY=sk_test_…, STRIPE_WEBHOOK_SECRET=whsec_…
//

const { PaymentGateway } = require('./PaymentGateway');

let stripeClient = null;
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    const err = new Error('Stripe is not configured (STRIPE_SECRET_KEY missing).');
    err.status = 503;
    throw err;
  }
  if (!stripeClient || stripeClient.__key !== key) {
    // Lazy require so the app boots fine even before `stripe` is installed.
    const Stripe = require('stripe');
    stripeClient = new Stripe(key, { maxNetworkRetries: 2 });
    stripeClient.__key = key;
  }
  return stripeClient;
}

function unix(ts) {
  return Number.isFinite(ts) ? new Date(ts * 1000) : null;
}

// Stripe subscription status → our internal SubscriptionStatus.
function mapStripeStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'trialing': return 'TRIALING';
    case 'active': return 'ACTIVE';
    case 'past_due': return 'PAST_DUE';
    case 'unpaid': return 'PAST_DUE';
    case 'paused': return 'PAUSED';
    case 'canceled': return 'CANCELLED';
    default: return null; // incomplete / incomplete_expired → not entitling yet
  }
}

function firstItem(subscription) {
  return subscription?.items?.data?.[0] || null;
}

class StripeGateway extends PaymentGateway {
  constructor() { super('STRIPE'); }

  isConfigured() { return Boolean(process.env.STRIPE_SECRET_KEY); }

  environment() {
    return String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_') ? 'test' : 'live';
  }

  raw() { return getStripe(); }

  async createSubscriptionCheckout({
    priceRef, quantity = 1, trialDays = null, customerEmail = null, customerRef = null,
    successUrl, cancelUrl, metadata = {}, businessId = null, idempotencyKey = null,
  }) {
    if (!priceRef) throw new Error('Stripe checkout requires a priceRef (Stripe price id).');
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceRef, quantity }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      ...(customerRef ? { customer: customerRef } : (customerEmail ? { customer_email: customerEmail } : {})),
      client_reference_id: businessId || metadata.businessId || undefined,
      allow_promotion_codes: true,
      subscription_data: {
        ...(trialDays ? { trial_period_days: trialDays } : {}),
        metadata,
      },
      metadata,
      // Idempotency key keyed on (business, tier, cycle): re-initiating the same
      // plan within Stripe's 24h window returns the SAME session instead of
      // minting a second one — the first guard against an abandoned-then-retried
      // checkout creating two subscriptions. (B9)
    }, idempotencyKey ? { idempotencyKey } : undefined);
    return { url: session.url, reference: session.id };
  }

  verifyWebhook({ rawBody, signatureHeader }) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      const err = new Error('STRIPE_WEBHOOK_SECRET is not configured.');
      err.status = 500;
      throw err;
    }
    // Throws Stripe.errors.StripeSignatureVerificationError on a bad signature.
    return getStripe().webhooks.constructEvent(rawBody, signatureHeader, secret);
  }

  normalizeEvent(event) {
    const base = { gateway: 'STRIPE', rawType: event?.type || '', metadata: {} };
    const obj = event?.data?.object || {};

    switch (event?.type) {
      case 'checkout.session.completed': {
        return {
          ...base,
          kind: 'transaction_completed',
          internalStatus: null,
          gatewayCustomerId: obj.customer || null,
          gatewaySubscriptionId: obj.subscription || null,
          gatewayTransactionId: obj.id || null,
          priceRef: null,
          currency: (obj.currency || '').toUpperCase() || null,
          amountMinor: Number.isFinite(obj.amount_total) ? obj.amount_total : null,
          currentPeriodEnd: null,
          metadata: obj.metadata || {},
        };
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const item = firstItem(obj);
        const status = event.type === 'customer.subscription.deleted' ? 'canceled' : obj.status;
        return {
          ...base,
          kind: 'subscription_change',
          internalStatus: mapStripeStatus(status),
          gatewayCustomerId: obj.customer || null,
          gatewaySubscriptionId: obj.id || null,
          gatewayTransactionId: obj.latest_invoice || null,
          priceRef: item?.price?.id || null,
          currency: (item?.price?.currency || obj.currency || '').toUpperCase() || null,
          amountMinor: Number.isFinite(item?.price?.unit_amount) ? item.price.unit_amount : null,
          // Stripe API 2025-03-31.basil+ (and stripe-node v22's pinned version)
          // REMOVED current_period_end from the top-level Subscription and moved
          // it onto each subscription ITEM. Read the item first, fall back to the
          // legacy top-level field so renewal dates work on both shapes — without
          // this the renewal date is null and entitlement/period scheduling break.
          currentPeriodEnd: unix(item?.current_period_end ?? obj.current_period_end),
          metadata: obj.metadata || {},
        };
      }
      case 'invoice.payment_failed': {
        return {
          ...base,
          kind: 'payment_failed',
          internalStatus: null,
          gatewayCustomerId: obj.customer || null,
          // Same 2025-03-31.basil+ reshape: an Invoice no longer carries
          // `subscription`/`price` at the top level — they live under
          // parent.subscription_details / lines[].pricing. Fall back across both.
          gatewaySubscriptionId: obj.parent?.subscription_details?.subscription || obj.subscription || null,
          gatewayTransactionId: obj.id || null,
          priceRef: obj.lines?.data?.[0]?.pricing?.price_details?.price || obj.lines?.data?.[0]?.price?.id || null,
          currency: (obj.currency || '').toUpperCase() || null,
          amountMinor: Number.isFinite(obj.amount_due) ? obj.amount_due : null,
          currentPeriodEnd: null,
          metadata: obj.parent?.subscription_details?.metadata || obj.subscription_details?.metadata || obj.metadata || {},
        };
      }
      case 'charge.refunded':
      case 'refund.created': {
        return {
          ...base,
          kind: 'refund',
          internalStatus: null,
          gatewayCustomerId: obj.customer || null,
          gatewaySubscriptionId: null,
          gatewayTransactionId: obj.payment_intent || obj.charge || obj.id || null,
          priceRef: null,
          currency: (obj.currency || '').toUpperCase() || null,
          amountMinor: Number.isFinite(obj.amount_refunded) ? obj.amount_refunded
            : (Number.isFinite(obj.amount) ? obj.amount : null),
          currentPeriodEnd: null,
          metadata: obj.metadata || {},
        };
      }
      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        // A successful subscription charge (the initial post-trial charge + every
        // renewal). Recorded into the payment ledger so NZ/Stripe tenants get a
        // Payment history + Latest payment like Paddle. NOT recorded from
        // checkout.session.completed (which only stamps the sub id) — avoids dup
        // rows. (B5)
        return {
          ...base,
          kind: 'charge',
          internalStatus: null,
          gatewayCustomerId: obj.customer || null,
          gatewaySubscriptionId: obj.parent?.subscription_details?.subscription || obj.subscription || null,
          gatewayTransactionId: obj.charge || obj.payment_intent || obj.id || null,
          priceRef: obj.lines?.data?.[0]?.pricing?.price_details?.price || obj.lines?.data?.[0]?.price?.id || null,
          currency: (obj.currency || '').toUpperCase() || null,
          amountMinor: Number.isFinite(obj.amount_paid) ? obj.amount_paid : null,
          currentPeriodEnd: null,
          metadata: obj.parent?.subscription_details?.metadata || obj.subscription_details?.metadata || obj.metadata || {},
        };
      }
      default:
        return { ...base, kind: 'ignored', internalStatus: null };
    }
  }

  async cancelSubscription(subscriptionRef, { immediately = false } = {}) {
    if (!subscriptionRef) throw new Error('cancelSubscription requires a Stripe subscription id.');
    const stripe = getStripe();
    return immediately
      ? stripe.subscriptions.cancel(subscriptionRef)
      : stripe.subscriptions.update(subscriptionRef, { cancel_at_period_end: true });
  }

  async createBillingPortalSession({ customerRef, returnUrl }) {
    if (!customerRef) throw new Error('createBillingPortalSession requires a Stripe customer id.');
    const session = await getStripe().billingPortal.sessions.create({
      customer: customerRef,
      return_url: returnUrl,
    });
    return { url: session.url, reference: session.id };
  }

  async getInvoiceUrl(invoiceRef, { customerRef = null, subscriptionRef = null } = {}) {
    if (!invoiceRef) throw new Error('getInvoiceUrl requires a Stripe invoice id.');
    const invoice = await getStripe().invoices.retrieve(invoiceRef);
    // `invoice.subscription` was removed from the top level in 2025-03-31.basil+
    // (now under invoice.parent.subscription_details.subscription) — resolve both
    // shapes so the ownership check doesn't wrongly 404 a valid invoice.
    const invoiceSubscription = typeof invoice.subscription === 'string'
      ? invoice.subscription
      : (invoice.subscription?.id || invoice.parent?.subscription_details?.subscription || null);
    const belongsToCustomer = customerRef && invoice.customer === customerRef;
    const belongsToSubscription = subscriptionRef && invoiceSubscription === subscriptionRef;
    if (!belongsToCustomer && !belongsToSubscription) {
      const err = new Error('That invoice does not belong to this business.');
      err.status = 404;
      throw err;
    }
    return invoice.invoice_pdf || invoice.hosted_invoice_url || null;
  }

  async refund({ paymentRef, amountMinor = null }) {
    if (!paymentRef) throw new Error('refund requires a Stripe payment_intent or charge id.');
    const payload = paymentRef.startsWith('ch_')
      ? { charge: paymentRef }
      : { payment_intent: paymentRef };
    if (Number.isFinite(amountMinor)) payload.amount = amountMinor;
    return getStripe().refunds.create(payload);
  }
}

module.exports = { StripeGateway, getStripe, mapStripeStatus };
