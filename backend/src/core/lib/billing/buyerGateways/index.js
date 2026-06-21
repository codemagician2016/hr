'use strict';

// Buyer-gateway registry — one place that maps a provider to its adapter, so the
// checkout + refund dispatch is uniform and adding a NEW gateway is a single new
// adapter file implementing the common interface:
//   { provider, isByo(account), keys(account),
//     createOrder({account, order}) -> { ok, paymentRef, checkout } | { ok:false, status, body },
//     refund({account, paymentRef, amountMinor}) -> { ok, refundId } | { ok:false, ... } }

const razorpayAdapter = require('./razorpayAdapter');
const stripeAdapter = require('./stripeAdapter');

const ADAPTERS = {
  RAZORPAY: razorpayAdapter,
  STRIPE: stripeAdapter,
};

function getBuyerGateway(provider) {
  return ADAPTERS[String(provider || '').toUpperCase()] || null;
}

module.exports = { getBuyerGateway, BUYER_GATEWAYS: Object.keys(ADAPTERS) };
