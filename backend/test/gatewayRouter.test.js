const {
  GATEWAYS,
  activeGatewayFromSubscription,
  gatewayMigrationBlock,
  resolveBilling,
  resolveGateway,
  resolvePresentmentCurrency,
  resolveTenantPaymentRoute,
  tenantGatewayCurrencyBlock,
  tenantGatewayMismatch,
  resolveTenantPaymentGateway,
} = require('../src/core/lib/billing/gatewayRouter');

describe('gatewayRouter', () => {
  const originalFlag = process.env.BILLING_MULTI_GATEWAY;

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.BILLING_MULTI_GATEWAY;
    else process.env.BILLING_MULTI_GATEWAY = originalFlag;
  });

  test('routes SaaS subscriptions to Razorpay for India, Stripe for NZ, and Paddle elsewhere', () => {
    delete process.env.BILLING_MULTI_GATEWAY;

    expect(resolveGateway('IN')).toBe(GATEWAYS.RAZORPAY);
    expect(resolvePresentmentCurrency('IN')).toBe('INR');

    expect(resolveGateway('NZ')).toBe(GATEWAYS.STRIPE);
    expect(resolvePresentmentCurrency('NZ')).toBe('NZD');

    expect(resolveBilling('GB')).toEqual({
      gateway: GATEWAYS.PADDLE,
      currency: 'GBP',
      country: 'GB',
    });
    expect(resolveBilling('DE')).toEqual({
      gateway: GATEWAYS.PADDLE,
      currency: 'EUR',
      country: 'DE',
    });
  });

  test('keeps the explicit emergency fallback that forces SaaS billing to Paddle', () => {
    process.env.BILLING_MULTI_GATEWAY = 'false';

    expect(resolveGateway('IN')).toBe(GATEWAYS.PADDLE);
    expect(resolvePresentmentCurrency('IN')).toBe('USD');
  });

  test('routes tenant order payments by tenant country before currency', () => {
    expect(resolveTenantPaymentGateway({ countryCode: 'IN', currency: 'USD' })).toBe(GATEWAYS.RAZORPAY);
    expect(resolveTenantPaymentGateway({ countryCode: 'US', currency: 'INR' })).toBe(GATEWAYS.STRIPE);
    expect(resolveTenantPaymentGateway({ currency: 'INR' })).toBe(GATEWAYS.RAZORPAY);
    expect(resolveTenantPaymentGateway({ countryCode: 'NZ', currency: 'NZD' })).toBe(GATEWAYS.STRIPE);
    expect(resolveTenantPaymentGateway({ countryCode: 'GB', currency: 'GBP' })).toBe(GATEWAYS.STRIPE);
  });

  test('explains tenant order payment route and blocks wrong provider/currency', () => {
    expect(resolveTenantPaymentRoute({ countryCode: 'IN', currency: 'INR' })).toEqual(expect.objectContaining({
      provider: GATEWAYS.RAZORPAY,
      model: 'RAZORPAY_PARTNER',
      expectedCurrency: 'INR',
    }));
    expect(resolveTenantPaymentRoute({ countryCode: 'NZ', currency: 'NZD' })).toEqual(expect.objectContaining({
      provider: GATEWAYS.STRIPE,
      model: 'STRIPE_CONNECT',
      expectedCurrency: null,
    }));
    expect(tenantGatewayMismatch({ provider: 'STRIPE', countryCode: 'IN', currency: 'INR' })).toEqual(expect.objectContaining({
      code: 'TENANT_GATEWAY_COUNTRY_MISMATCH',
      requiredProvider: GATEWAYS.RAZORPAY,
    }));
    expect(tenantGatewayMismatch({ provider: 'RAZORPAY', countryCode: 'US', currency: 'USD' })).toEqual(expect.objectContaining({
      code: 'TENANT_GATEWAY_COUNTRY_MISMATCH',
      requiredProvider: GATEWAYS.STRIPE,
    }));
    expect(tenantGatewayCurrencyBlock({ provider: 'RAZORPAY', currency: 'USD' })).toEqual(expect.objectContaining({
      code: 'TENANT_GATEWAY_CURRENCY_MISMATCH',
      requiredCurrency: 'INR',
    }));
    expect(tenantGatewayCurrencyBlock({ provider: 'RAZORPAY', currency: 'INR' })).toBeNull();
  });

  test('detects active subscription gateway and blocks unsafe cross-gateway plan changes', () => {
    const sub = { paddleSubscriptionId: 'sub_paddle_1' };

    expect(activeGatewayFromSubscription(sub)).toBe(GATEWAYS.PADDLE);
    expect(gatewayMigrationBlock({ subscription: sub, targetGateway: GATEWAYS.PADDLE })).toBeNull();
    expect(gatewayMigrationBlock({ subscription: sub, targetGateway: GATEWAYS.RAZORPAY })).toEqual(expect.objectContaining({
      code: 'GATEWAY_MIGRATION_REQUIRED',
      activeGateway: GATEWAYS.PADDLE,
      targetGateway: GATEWAYS.RAZORPAY,
    }));
  });
});
