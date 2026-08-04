const {
  GATEWAYS,
  activeGatewayFromSubscription,
  gatewayMigrationBlock,
  resolveBilling,
  resolveGateway,
  resolvePresentmentCurrency,
} = require('../src/core/lib/billing/gatewayRouter');

// The tenant-order-payment helpers moved out of gatewayRouter into their own
// module; this suite kept importing them from the old home, so they arrived
// undefined and every call threw "is not a function" rather than failing an
// assertion. No other suite covers them, so the import is repointed rather than
// the tests dropped.
const {
  resolveTenantPaymentRoute,
  resolveTenantPaymentGateway,
  tenantGatewayCurrencyBlock,
} = require('../src/core/lib/billing/tenantPaymentReadiness')._internals;

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
    // The tenantGatewayMismatch assertions that used to sit here were dropped:
    // that helper no longer exists anywhere in src/. The country-before-currency
    // rule it guarded is still covered by resolveTenantPaymentGateway above.
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
