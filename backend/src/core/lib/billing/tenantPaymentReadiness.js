const {
  GATEWAYS,
  gatewayLabel,
  resolveTenantPaymentRoute,
  tenantGatewayCurrencyBlock,
} = require('./gatewayRouter');

function normalizeStatus(value) {
  return String(value || '').trim().toUpperCase();
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
};
