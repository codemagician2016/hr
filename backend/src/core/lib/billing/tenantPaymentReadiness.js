// Buyer-side (storefront / ecommerce) payment readiness. This is intentionally
// SELF-CONTAINED: the SaaS-subscription gatewayRouter no longer carries any
// buyer/tenant payment routing (billing-trim, 2026-06-22), so the small amount
// of buyer routing this module still needs lives here. HR has no buyer
// checkout; the only consumer is the legacy ecommerce storefront payment-mode
// guard in business.controller.js.
const {
  GATEWAYS,
  gatewayLabel,
  normalizeCountry,
} = require('./gatewayRouter');

function normalizeStatus(value) {
  return String(value || '').trim().toUpperCase();
}

// Which provider runs buyer checkout for a store: India → Razorpay Route,
// everywhere else → Stripe Connect. (Moved out of gatewayRouter in the
// billing-trim so the SaaS gateway router stays subscription-only.)
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

function providerSetupCopy(provider) {
  if (provider === GATEWAYS.RAZORPAY) {
    return {
      providerLabel: 'Razorpay',
      accountLabel: 'Razorpay connected account',
      setupVerb: 'Go to Razorpay',
      pendingVerb: 'Check Razorpay status',
      notStarted: 'Connect Razorpay hosted onboarding for India checkout.',
      pending: 'Complete Razorpay onboarding before online checkout can go live.',
      active: 'Razorpay is active for buyer checkout.',
      envMissing: 'Razorpay hosted onboarding or fallback keys are not configured on the backend.',
    };
  }
  return {
    providerLabel: 'Stripe',
    accountLabel: 'Stripe Connect account',
    setupVerb: 'Connect with Stripe',
    pendingVerb: 'Continue Stripe onboarding',
    notStarted: 'Create a Stripe Express connected account.',
    pending: 'Complete Stripe onboarding, identity checks, and payout setup before online checkout can go live.',
    active: 'Stripe Connect is active for buyer checkout.',
    envMissing: 'Stripe Connect keys are not configured on the backend.',
  };
}

function stepStatus(done, blocked = false) {
  if (done) return 'DONE';
  return blocked ? 'BLOCKED' : 'TODO';
}

function buildTenantPaymentReadiness({
  business = {},
  currency,
  account,
  providerConfigured = true,
} = {}) {
  const route = resolveTenantPaymentRoute({
    countryCode: business.country,
    currency,
  });
  const provider = route.provider;
  const copy = providerSetupCopy(provider);
  const status = normalizeStatus(account?.status);
  const hasAccount = Boolean(account?.accountId);
  const currencyBlock = tenantGatewayCurrencyBlock({ provider, currency });
  const accountActive = hasAccount && status === 'ACTIVE';
  const issues = [];

  if (route.countryRequired) {
    issues.push({
      code: 'BUSINESS_COUNTRY_REQUIRED',
      message: 'Set the store country before enabling online payments.',
    });
  }
  if (currencyBlock) {
    issues.push({
      code: currencyBlock.code,
      message: currencyBlock.message,
    });
  }
  if (!providerConfigured) {
    issues.push({
      code: 'PROVIDER_BACKEND_NOT_CONFIGURED',
      message: copy.envMissing,
    });
  }
  if (!hasAccount) {
    issues.push({
      code: 'PROVIDER_ACCOUNT_REQUIRED',
      message: copy.notStarted,
    });
  } else if (!accountActive) {
    issues.push({
      code: 'PROVIDER_ACCOUNT_PENDING',
      message: copy.pending,
      status: status || 'PENDING',
    });
  }

  const canAcceptOnline = issues.length === 0;
  const setupState = canAcceptOnline
    ? 'READY'
    : !hasAccount
      ? 'NOT_STARTED'
      : route.countryRequired || currencyBlock || !providerConfigured
        ? 'BLOCKED'
        : 'PENDING';

  const headline = canAcceptOnline
    ? 'Online payments are ready'
    : setupState === 'PENDING'
      ? `${copy.providerLabel} onboarding is in progress`
      : `Connect ${copy.providerLabel} before enabling online payments`;

  const message = canAcceptOnline
    ? copy.active
    : issues[0]?.message || `Finish ${copy.accountLabel} setup before enabling online checkout.`;

  return {
    canAcceptOnline,
    canEnableOnlineMode: canAcceptOnline,
    setupState,
    headline,
    message,
    provider,
    providerLabel: copy.providerLabel,
    accountLabel: copy.accountLabel,
    accountId: account?.accountId || null,
    accountStatus: status || null,
    country: route.country,
    countryRequired: route.countryRequired,
    currency: route.currency,
    expectedCurrency: route.expectedCurrency,
    model: route.model,
    modelLabel: route.modelLabel,
    providerConfigured: Boolean(providerConfigured),
    issues,
    primaryAction: canAcceptOnline
      ? { key: 'STORE_SETUP', label: 'Turn on online payments' }
      : hasAccount
        ? { key: `${provider}_STATUS`, label: copy.pendingVerb }
        : { key: `${provider}_START`, label: copy.setupVerb },
    steps: [
      {
        key: 'country_currency',
        label: 'Store country and currency',
        status: stepStatus(!route.countryRequired && !currencyBlock, route.countryRequired || !!currencyBlock),
        detail: route.countryRequired
          ? 'Store country is required.'
          : currencyBlock?.message || `${route.country || 'Store'} checkout route resolved.`,
      },
      {
        key: 'backend',
        label: `${copy.providerLabel} backend keys`,
        status: stepStatus(providerConfigured, true),
        detail: providerConfigured ? `${copy.providerLabel} is configured.` : copy.envMissing,
      },
      {
        key: 'account',
        label: copy.accountLabel,
        status: stepStatus(hasAccount, false),
        detail: hasAccount ? `Account ${account.accountId}` : copy.notStarted,
      },
      {
        key: 'kyc',
        label: 'KYC and payout readiness',
        status: stepStatus(accountActive, hasAccount),
        detail: accountActive ? copy.active : (hasAccount ? copy.pending : 'Start onboarding first.'),
      },
    ],
  };
}

function paymentModeRequiresOnline(paymentMode) {
  return ['BOTH', 'PREPAID_ONLY'].includes(normalizeStatus(paymentMode || 'BOTH'));
}

function effectivePaymentMode({ configuredMode = 'BOTH', onlineReady = false } = {}) {
  const mode = normalizeStatus(configuredMode || 'BOTH');
  if (mode === 'PREPAID_ONLY' && !onlineReady) return 'COD_ONLY';
  return mode;
}

function onlineModeBlock({ paymentMode, readiness } = {}) {
  const mode = normalizeStatus(paymentMode || 'BOTH');
  if (!paymentModeRequiresOnline(mode) || readiness?.canAcceptOnline) return null;
  return {
    code: 'ONLINE_PAYMENT_GATEWAY_REQUIRED',
    message: `${readiness?.providerLabel || 'Payment gateway'} is not ready yet. Keep Cash only enabled until payment onboarding is complete.`,
    requiredProvider: readiness?.provider || null,
    requiredProviderLabel: readiness?.providerLabel || null,
    readiness,
  };
}

module.exports = {
  buildTenantPaymentReadiness,
  effectivePaymentMode,
  onlineModeBlock,
  paymentModeRequiresOnline,
  // Exported for tests only — the country-before-currency routing these two
  // implement is the rule buildTenantPaymentReadiness depends on, and it is
  // worth asserting directly rather than only through the composed readiness
  // payload. Same `_internals` idiom as candidateNotify.js; not a public API.
  _internals: {
    resolveTenantPaymentGateway,
    resolveTenantPaymentRoute,
    tenantGatewayCurrencyBlock,
  },
};
