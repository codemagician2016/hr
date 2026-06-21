const {
  buildTenantPaymentReadiness,
  effectivePaymentMode,
  onlineModeBlock,
} = require('../src/core/lib/billing/tenantPaymentReadiness');

describe('tenant payment readiness', () => {
  test('blocks India online modes until Razorpay linked account is active', () => {
    const readiness = buildTenantPaymentReadiness({
      business: { country: 'IN' },
      currency: 'INR',
      account: null,
      providerConfigured: true,
    });

    expect(readiness).toMatchObject({
      canAcceptOnline: false,
      provider: 'RAZORPAY',
      setupState: 'NOT_STARTED',
    });
    expect(onlineModeBlock({ paymentMode: 'BOTH', readiness })).toMatchObject({
      code: 'ONLINE_PAYMENT_GATEWAY_REQUIRED',
      requiredProvider: 'RAZORPAY',
    });
  });

  test('allows online mode when the required account is active', () => {
    const readiness = buildTenantPaymentReadiness({
      business: { country: 'NZ' },
      currency: 'NZD',
      account: { provider: 'STRIPE', accountId: 'acct_123', status: 'ACTIVE' },
      providerConfigured: true,
    });

    expect(readiness).toMatchObject({
      canAcceptOnline: true,
      provider: 'STRIPE',
      setupState: 'READY',
    });
    expect(onlineModeBlock({ paymentMode: 'PREPAID_ONLY', readiness })).toBeNull();
  });

  test('falls stale prepaid-only stores back to cash-only until online is ready', () => {
    expect(effectivePaymentMode({ configuredMode: 'PREPAID_ONLY', onlineReady: false })).toBe('COD_ONLY');
    expect(effectivePaymentMode({ configuredMode: 'PREPAID_ONLY', onlineReady: true })).toBe('PREPAID_ONLY');
    expect(effectivePaymentMode({ configuredMode: 'BOTH', onlineReady: false })).toBe('BOTH');
  });

  test('explains country and currency blockers', () => {
    const missingCountry = buildTenantPaymentReadiness({
      business: {},
      currency: 'USD',
      providerConfigured: true,
    });
    expect(missingCountry.countryRequired).toBe(true);
    expect(missingCountry.issues.map((issue) => issue.code)).toContain('BUSINESS_COUNTRY_REQUIRED');

    const wrongCurrency = buildTenantPaymentReadiness({
      business: { country: 'IN' },
      currency: 'USD',
      account: { provider: 'RAZORPAY', accountId: 'acc_123', status: 'ACTIVE' },
      providerConfigured: true,
    });
    expect(wrongCurrency.canAcceptOnline).toBe(false);
    expect(wrongCurrency.issues.map((issue) => issue.code)).toContain('TENANT_GATEWAY_CURRENCY_MISMATCH');
  });
});
