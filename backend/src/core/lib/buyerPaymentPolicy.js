'use strict';

// Buyer-payment policy — integrated (Stripe Connect / Razorpay Route) vs BYO.
//
// INTEGRATED = Sitepresso is the platform-of-record in the money flow, so it
// carries fraud / KYC / chargeback liability. BYO = the seller connects their
// OWN gateway keys; funds go straight to them and Sitepresso is never in the
// flow → no liability. The owner's stance: default to BYO-only for safety, and
// opt INTO integrated per-country only when ready for that liability.

const prisma = require('./prisma');
const { normalizeCountry } = require('./billing/gatewayRouter');

// Global default. We'd LIKE BYO-only for safety, but a country can only run
// BYO-only once a BYO path exists for its gateway — today that's Razorpay (IN);
// Stripe countries still need Stripe-BYO built. So the default stays ON
// (non-breaking: integrated remains available where it's the only path) and the
// owner opts a country into BYO-only per-country once its BYO path is ready.
// Flip the whole platform to BYO-only with INTEGRATED_BUYER_PAYMENTS_DEFAULT=off;
// per-country PaymentCountryPolicy rows always win over this.
function integratedDefaultOn() {
  return String(process.env.INTEGRATED_BUYER_PAYMENTS_DEFAULT || 'on').toLowerCase() !== 'off';
}

// Is INTEGRATED buyer payment allowed for this country? Default = global default
// (OFF). A PaymentCountryPolicy row for the country overrides.
async function integratedBuyerPaymentsAllowed(countryCode) {
  const country = normalizeCountry(countryCode);
  if (!country) return integratedDefaultOn();
  const row = await prisma.paymentCountryPolicy
    .findUnique({ where: { countryCode: country } })
    .catch(() => null);
  return row ? !!row.integratedEnabled : integratedDefaultOn();
}

module.exports = { integratedBuyerPaymentsAllowed, integratedDefaultOn };
