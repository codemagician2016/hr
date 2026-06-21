'use strict';

// Razorpay buyer-payment adapter — implements the common buyer-gateway interface.
// India BYO: orders are created on the tenant's OWN Razorpay account with their
// keys; Sitepresso is never in the funds flow.

const razorpay = require('../../razorpayRoute');
const { decrypt } = require('../../crypto');

function meta(account) {
  const m = account?.metadata;
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}
function isByo(account) {
  return account?.provider === 'RAZORPAY' && meta(account).connectionModel === 'BYO_KEYS';
}
function keys(account) {
  const m = meta(account);
  return {
    keyId: m.keyId || account?.accountId || null,
    keySecret: m.keySecretEncrypted ? decrypt(m.keySecretEncrypted) : null,
    webhookSecret: m.webhookSecretEncrypted ? decrypt(m.webhookSecretEncrypted) : null,
  };
}

module.exports = {
  provider: 'RAZORPAY',
  isByo,
  keys,

  // Create the buyer's payment order. Returns { ok, paymentRef, checkout } or
  // { ok:false, status, body } for the controller to relay.
  async createOrder({ account, order }) {
    if (!isByo(account)) {
      return { ok: false, status: 409, body: { message: 'Seller has not connected their Razorpay account yet', reason: 'PROVIDER_NOT_READY' } };
    }
    const k = keys(account);
    if (!k.keyId || !k.keySecret) {
      return { ok: false, status: 409, body: { message: 'Seller Razorpay keys are missing — please reconnect Razorpay', reason: 'PROVIDER_NOT_READY' } };
    }
    const r = await razorpay.createOrderWithKeys({
      keyId: k.keyId, keySecret: k.keySecret,
      amountMinor: order.totalMinor, currency: order.currency,
      receipt: String(order.id).slice(-12),
      notes: { orderId: order.id, businessId: order.businessId },
    });
    if (!r.ok) return { ok: false, status: 502, body: { message: r.message || 'Razorpay error', reason: r.reason } };
    return {
      ok: true,
      paymentRef: r.orderId,
      checkout: { provider: 'RAZORPAY', orderId: r.orderId, amount: r.amount, currency: r.currency, keyId: k.keyId },
    };
  },

  // Refund a captured payment. Preserves existing behaviour (platform key +
  // X-Razorpay-Account sub-merchant when the account is a Route acc_).
  async refund({ account, paymentRef, amountMinor }) {
    const subMerchant = String(account?.accountId || '').startsWith('acc_') ? account.accountId : null;
    return razorpay.refundPayment({ paymentId: paymentRef, amountMinor, subMerchantAccountId: subMerchant });
  },
};
