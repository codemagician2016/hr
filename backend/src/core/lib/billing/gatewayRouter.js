//
// gatewayRouter.js — single source of truth for payment-gateway routing.
//
// SaaS subscriptions:
//   India (IN)        → Razorpay subscriptions            → INR
//   New Zealand (NZ)  → Stripe Billing                    → NZD
//   Rest of world     → Paddle Merchant of Record          → GBP (UK) / EUR (eurozone) / USD
//
// Tenant/store order payments:
//   India tenants     → Razorpay Partner/Route
//   Non-India tenants → Stripe Connect direct charges
//
// The amount within a currency is still set by the existing PPP *zone* system
// (TierPrice rows + zone multipliers) — this module only answers gateway +
// presentment currency, not the number.
//
// BILLING_MULTI_GATEWAY can be set to "false" as an emergency fallback to force
// SaaS subscriptions through Paddle. It defaults on because the business model
// now requires India to bill through Razorpay and NZ through Stripe.
//

const GATEWAYS = Object.freeze({
  PADDLE: 'PADDLE',
  STRIPE: 'STRIPE',
  RAZORPAY: 'RAZORPAY',
});

// Countries that get a dedicated local gateway. Everything else → Paddle.
const COUNTRY_GATEWAY = Object.freeze({
  IN: GATEWAYS.RAZORPAY,
  NZ: GATEWAYS.STRIPE,
});

// Fixed presentment currency for the dedicated-gateway countries.
const GATEWAY_FIXED_CURRENCY = Object.freeze({
  [GATEWAYS.RAZORPAY]: 'INR',
  [GATEWAYS.STRIPE]: 'NZD',
});

// The ONLY currencies we actually bill in (Shopify-style fixed set): INR
// (Razorpay/India), NZD (Stripe/NZ), and GBP/EUR/USD (Paddle/RoW). Any legacy
// per-country TierPrice in another currency is treated as inert — the price
// lookup ignores it and falls back to the supported-currency row, and the admin
// pricing screen hides it. This keeps the catalog effectively 5-currency without
// deleting historical rows.
const SUPPORTED_BILLING_CURRENCIES = Object.freeze(['INR', 'NZD', 'GBP', 'EUR', 'USD', 'AUD']);
function isSupportedBillingCurrency(code) {
  return SUPPORTED_BILLING_CURRENCIES.includes(String(code || '').toUpperCase());
}

// Euro-using countries (official eurozone + states that use EUR). Paddle
// countries in this set present in EUR; the UK presents in GBP; all other
// Paddle countries present in USD. GBP is effectively UK-only (zone 1) per the
// owner's frozen spec.
const EUROZONE = new Set([
  'AD', 'AT', 'BE', 'HR', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'MC', 'ME', 'NL', 'PT', 'SM', 'SK', 'SI', 'ES',
  'VA', 'XK',
]);
const GBP_COUNTRIES = new Set(['GB', 'UK']);
// Australia + AUD-using territories/nations. Paddle (MoR) bills these in AUD.
const AUD_COUNTRIES = new Set(['AU', 'CX', 'CC', 'NF', 'KI', 'NR', 'TV']);

function normalizeCountry(countryCode) {
  const c = String(countryCode || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

function isMultiGatewayEnabled() {
  return String(process.env.BILLING_MULTI_GATEWAY || 'true').toLowerCase() !== 'false';
}

// Which gateway handles SaaS subscription billing for a country.
function resolveGateway(countryCode) {
  if (!isMultiGatewayEnabled()) return GATEWAYS.PADDLE;
  const country = normalizeCountry(countryCode);
  if (!country) return GATEWAYS.PADDLE;
  return COUNTRY_GATEWAY[country] || GATEWAYS.PADDLE;
}

// Presentment currency for a country under the frozen model.
//   Razorpay subscriptions → INR, Stripe subscriptions → NZD,
//   Paddle MoR             → GBP (UK) / EUR (eurozone) / USD.
// When multi-gateway is off, falls back to the Paddle group rules so callers
// always get a sane currency.
function resolvePresentmentCurrency(countryCode) {
  const gateway = resolveGateway(countryCode);
  if (GATEWAY_FIXED_CURRENCY[gateway]) return GATEWAY_FIXED_CURRENCY[gateway];

  const country = normalizeCountry(countryCode);
  if (country && GBP_COUNTRIES.has(country)) return 'GBP';
  if (country && EUROZONE.has(country)) return 'EUR';
  if (country && AUD_COUNTRIES.has(country)) return 'AUD';
  return 'USD';
}

// Convenience: the full routing decision for a country.
//   { gateway, currency, country }
function resolveBilling(countryCode) {
  return {
    gateway: resolveGateway(countryCode),
    currency: resolvePresentmentCurrency(countryCode),
    country: normalizeCountry(countryCode),
  };
}

function resolveTenantPaymentGateway({ countryCode, currency } = {}) {
  const country = normalizeCountry(countryCode);
  const normalizedCurrency = String(currency || '').trim().toUpperCase();
  if (country) return country === 'IN' ? GATEWAYS.RAZORPAY : GATEWAYS.STRIPE;
  if (normalizedCurrency === 'INR') return GATEWAYS.RAZORPAY;
  return GATEWAYS.STRIPE;
}

function tenantPaymentModel(provider) {
  return provider === GATEWAYS.RAZORPAY ? 'RAZORPAY_PARTNER' : 'STRIPE_CONNECT';
}

function tenantPaymentModelLabel(provider) {
  return provider === GATEWAYS.RAZORPAY ? 'Razorpay Route linked account' : 'Stripe Connect account';
}

function resolveTenantPaymentRoute({ countryCode, currency } = {}) {
  const country = normalizeCountry(countryCode);
  const normalizedCurrency = String(currency || '').trim().toUpperCase() || null;
  const provider = resolveTenantPaymentGateway({ countryCode, currency });
  return {
    provider,
    gateway: provider,
    providerLabel: gatewayLabel(provider),
    model: tenantPaymentModel(provider),
    modelLabel: tenantPaymentModelLabel(provider),
    country,
    currency: normalizedCurrency,
    expectedCurrency: provider === GATEWAYS.RAZORPAY ? 'INR' : null,
    countryRequired: !country,
  };
}

function tenantGatewayMismatch({ provider, countryCode, currency } = {}) {
  const requested = String(provider || '').trim().toUpperCase();
  if (!requested) return null;
  const route = resolveTenantPaymentRoute({ countryCode, currency });
  if (requested === route.provider) return null;
  return {
    code: 'TENANT_GATEWAY_COUNTRY_MISMATCH',
    message: `${route.providerLabel} is the required online payment provider for this store country. ${gatewayLabel(requested)} is not used for buyer checkout here.`,
    requestedProvider: requested,
    requiredProvider: route.provider,
    requiredProviderLabel: route.providerLabel,
    country: route.country,
    currency: route.currency,
    model: route.model,
  };
}

function tenantGatewayCurrencyBlock({ provider, currency } = {}) {
  const gateway = String(provider || '').trim().toUpperCase();
  const code = String(currency || '').trim().toUpperCase();
  if (gateway === GATEWAYS.RAZORPAY && code && code !== 'INR') {
    return {
      code: 'TENANT_GATEWAY_CURRENCY_MISMATCH',
      message: 'Razorpay Route checkout for India stores must use INR. Change the store currency to INR before accepting online payments for this location.',
      provider: GATEWAYS.RAZORPAY,
      requiredCurrency: 'INR',
      currency: code,
    };
  }
  return null;
}

function activeGatewayFromSubscription(subscription) {
  if (!subscription) return null;
  // Prefer the persisted `gateway` column — it's the authoritative record of
  // which gateway the sub is actually on. Id-presence is only a fallback; a
  // hardcoded razorpay→stripe→paddle precedence would misroute a tenant who
  // carries a STALE id from a prior gateway alongside their live one. (B22)
  const persisted = String(subscription.gateway || '').toUpperCase();
  if (persisted === GATEWAYS.RAZORPAY && subscription.razorpaySubscriptionId) return GATEWAYS.RAZORPAY;
  if (persisted === GATEWAYS.STRIPE && subscription.stripeSubscriptionId) return GATEWAYS.STRIPE;
  if (persisted === GATEWAYS.PADDLE && subscription.paddleSubscriptionId) return GATEWAYS.PADDLE;
  if (subscription.razorpaySubscriptionId) return GATEWAYS.RAZORPAY;
  if (subscription.stripeSubscriptionId) return GATEWAYS.STRIPE;
  if (subscription.paddleSubscriptionId) return GATEWAYS.PADDLE;
  return null;
}

// Which gateway to USE for a plan change / billing op on an EXISTING subscription.
// You never migrate payment gateways merely by changing plan — country routing
// only chooses the gateway for a brand-NEW subscription. So if the tenant already
// has an active gateway subscription, that gateway wins (e.g. an India tenant on
// Paddle keeps changing plans on Paddle, whose price IDs exist, instead of being
// forced onto Razorpay and blocked on unpublished plans / a spurious "migrate"
// wall). With no active subscription, fall back to country routing.
// Switching gateways is a deliberate billing-country migration, guarded separately.
function resolveGatewayForChange({ subscription, countryCode } = {}) {
  return activeGatewayFromSubscription(subscription) || resolveGateway(countryCode);
}

function gatewayLabel(gateway) {
  if (gateway === GATEWAYS.STRIPE) return 'Stripe';
  if (gateway === GATEWAYS.RAZORPAY) return 'Razorpay';
  return 'Paddle';
}

function gatewayMigrationBlock({ subscription, targetGateway, paidTarget = true } = {}) {
  if (!paidTarget) return null;
  const activeGateway = activeGatewayFromSubscription(subscription);
  const nextGateway = targetGateway || null;
  if (!activeGateway || !nextGateway || activeGateway === nextGateway) return null;
  return {
    code: 'GATEWAY_MIGRATION_REQUIRED',
    message: `This account already has an active ${gatewayLabel(activeGateway)} subscription. Change billing country back to that gateway region or contact support to migrate billing before choosing a ${gatewayLabel(nextGateway)} plan.`,
    activeGateway,
    targetGateway: nextGateway,
  };
}

module.exports = {
  GATEWAYS,
  EUROZONE,
  SUPPORTED_BILLING_CURRENCIES,
  isSupportedBillingCurrency,
  activeGatewayFromSubscription,
  gatewayLabel,
  gatewayMigrationBlock,
  isMultiGatewayEnabled,
  normalizeCountry,
  resolveGateway,
  resolveGatewayForChange,
  resolvePresentmentCurrency,
  resolveBilling,
  resolveTenantPaymentGateway,
  resolveTenantPaymentRoute,
  tenantGatewayCurrencyBlock,
  tenantGatewayMismatch,
};
