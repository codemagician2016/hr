//
// gatewayRouter.smoke.js — zero-dependency smoke test for SaaS-subscription
// gateway routing. gatewayRouter is a PURE module (no DB/network), so this can
// run directly:  node backend/src/core/lib/billing/gatewayRouter.smoke.js
//
// Proves the frozen country routing survived the billing-trim:
//   IN → Razorpay / INR,  NZ → Stripe / NZD,  AU (RoW) → Paddle / AUD.
//
const assert = require('assert');
const { resolveBilling, GATEWAYS } = require('./gatewayRouter');

const cases = [
  ['IN', GATEWAYS.RAZORPAY, 'INR'],
  ['NZ', GATEWAYS.STRIPE, 'NZD'],
  ['AU', GATEWAYS.PADDLE, 'AUD'],
];

for (const [country, gateway, currency] of cases) {
  const got = resolveBilling(country);
  assert.strictEqual(got.gateway, gateway, `country=${country} gateway: expected ${gateway}, got ${got.gateway}`);
  assert.strictEqual(got.currency, currency, `country=${country} currency: expected ${currency}, got ${got.currency}`);
  assert.strictEqual(got.country, country, `country=${country} normalized country mismatch: got ${got.country}`);
  console.log(`  ✓ ${country} → ${got.gateway} / ${got.currency}`);
}

console.log('gatewayRouter smoke: PASS (IN→razorpay/INR, NZ→stripe/NZD, AU→paddle/AUD)');
