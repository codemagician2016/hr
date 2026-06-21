//
// Gateway registry — maps a gateway name to its adapter instance, and resolves
// the right adapter for a country via the router. Callers do:
//
//   const { getGatewayForCountry } = require('.../billing/gateways');
//   const gw = getGatewayForCountry(business.billingCountry);   // Stripe/Paddle/Razorpay
//   const { url } = await gw.createSubscriptionCheckout({ ... });
//
// Paddle keeps its existing dedicated controller/flow for now; it's registered
// here as a thin presence so the registry is complete and isConfigured()/
// environment() work uniformly. Wiring Paddle's checkout/webhook through this
// interface is a later refactor — the abstraction is additive, not a rewrite.
//

const { GATEWAYS, resolveGateway } = require('../gatewayRouter');
const { PaymentGateway } = require('./PaymentGateway');
const { StripeGateway } = require('./stripeGateway');
const { RazorpayGateway } = require('./razorpayGateway');

// Minimal Paddle presence. Real Paddle checkout/webhook still live in
// core/lib/paddle.js + core/controllers/paddle.controller.js.
class PaddleGatewayShim extends PaymentGateway {
  constructor() { super('PADDLE'); }
  isConfigured() {
    try { return require('../../paddle').isPaddleConfigured(); } catch { return false; }
  }
  environment() {
    try { return require('../../paddle').getPaddleEnvironment(); } catch { return 'live'; }
  }
}

const REGISTRY = {
  [GATEWAYS.PADDLE]: new PaddleGatewayShim(),
  [GATEWAYS.STRIPE]: new StripeGateway(),
  [GATEWAYS.RAZORPAY]: new RazorpayGateway(),
};

function getGateway(name) {
  const gw = REGISTRY[String(name || '').toUpperCase()];
  if (!gw) throw new Error(`Unknown billing gateway: ${name}`);
  return gw;
}

function getGatewayForCountry(countryCode) {
  return getGateway(resolveGateway(countryCode));
}

module.exports = { GATEWAYS, getGateway, getGatewayForCountry, REGISTRY };
