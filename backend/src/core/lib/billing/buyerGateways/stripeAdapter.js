'use strict';

// Stripe buyer-payment adapter — implements the common buyer-gateway interface.
// Two modes: BYO (PaymentIntent on the tenant's OWN account, their keys, no fee)
// and Connect (direct charge on the connected account + application_fee).

const stripe = require('../../stripeConnect');
const { decrypt } = require('../../crypto');

function meta(account) {
  const m = account?.metadata;
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}
function isByo(account) {
  return account?.provider === 'STRIPE' && meta(account).connectionModel === 'BYO_KEYS';
}
function keys(account) {
  const m = meta(account);
  return {
    publishableKey: m.publishableKey || account?.accountId || null,
    secretKey: m.secretKeyEncrypted ? decrypt(m.secretKeyEncrypted) : null,
    webhookSecret: m.webhookSecretEncrypted ? decrypt(m.webhookSecretEncrypted) : null,
  };
}

module.exports = {
  provider: 'STRIPE',
  isByo,
  keys,

  async createOrder({ account, order }) {
    if (isByo(account)) {
      const k = keys(account);
      if (!k.secretKey) {
        return { ok: false, status: 409, body: { message: 'Seller Stripe keys are missing — please reconnect Stripe', reason: 'PROVIDER_NOT_READY' } };
      }
      const r = await stripe.createPaymentIntentWithKey({
        secretKey: k.secretKey, amountMinor: order.totalMinor, currency: order.currency,
        metadata: { orderId: order.id, businessId: order.businessId },
      });
      if (!r.ok) return { ok: false, status: 502, body: { message: r.message || 'Stripe error', reason: r.reason } };
      return {
        ok: true,
        paymentRef: r.paymentIntentId,
        checkout: { provider: 'STRIPE', mode: 'BYO', clientSecret: r.clientSecret, paymentIntentId: r.paymentIntentId, publishableKey: k.publishableKey },
      };
    }
    // Connect — direct charge on the seller's connected account (tenant = MoR).
    const r = await stripe.createDirectCharge({
      amountMinor: order.totalMinor, currency: order.currency,
      connectedAccountId: account.accountId, platformFeePct: Number(account.platformFeePct),
      metadata: { orderId: order.id, businessId: order.businessId },
    });
    if (!r.ok) return { ok: false, status: 502, body: { message: r.message || 'Stripe error', reason: r.reason } };
    return {
      ok: true,
      paymentRef: r.paymentIntentId,
      checkout: { provider: 'STRIPE', mode: 'CONNECT', clientSecret: r.clientSecret, paymentIntentId: r.paymentIntentId, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY, connectedAccountId: account.accountId },
    };
  },

  async refund({ account, paymentRef, amountMinor }) {
    if (isByo(account)) {
      const k = keys(account);
      return stripe.refundWithKey({ secretKey: k.secretKey, paymentIntentId: paymentRef, amountMinor });
    }
    return stripe.refundDirectCharge({ paymentIntentId: paymentRef, amountMinor, connectedAccountId: account?.accountId || null });
  },
};
