jest.mock('../src/core/lib/prisma', () => ({
  business: {
    findUnique: jest.fn(),
  },
  subscription: {
    findUnique: jest.fn(),
  },
  pricingTier: {
    findUnique: jest.fn(),
  },
  service: {
    count: jest.fn(),
  },
  appointment: {
    count: jest.fn(),
  },
  staffSchedule: {
    count: jest.fn(),
  },
  product: {
    count: jest.fn(),
  },
  order: {
    count: jest.fn(),
  },
  productCategory: {
    count: jest.fn(),
  },
}));

jest.mock('../src/core/lib/paddle', () => ({
  isPaddleConfigured: jest.fn(),
}));

jest.mock('../src/core/lib/subscriptionBilling', () => ({
  FREE_TIER_SLUG: 'free',
  FREE_TIER_SLUGS: new Set(['free', 'static-free', 'ecom-free']),
  getPriceIdForBillingCycle: jest.fn((row, billingCycle) => (
    billingCycle === 'YEARLY' ? row?.paddlePriceIdAnnual || null : row?.paddlePriceIdMonthly || null
  )),
  normalizeCountryCode: jest.fn((countryCode) => {
    const normalized = String(countryCode || '').trim().toUpperCase();
    return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
  }),
  resolveTierPriceRecord: jest.fn(),
}));

const prisma = require('../src/core/lib/prisma');
const { isPaddleConfigured } = require('../src/core/lib/paddle');
const { resolveTierPriceRecord } = require('../src/core/lib/subscriptionBilling');
const { buildBillingChangePreview } = require('../src/core/lib/billingChangePreview');

const CURRENT_TIER = {
  id: 'tier_starter',
  slug: 'starter',
  name: 'Starter',
  vertical: 'APPOINTMENT',
  sortOrder: 2,
  isActive: true,
  isCustomPriced: false,
  features: ['Bookings'],
};

const PROFESSIONAL_TIER = {
  id: 'tier_professional',
  slug: 'professional',
  name: 'Professional',
  vertical: 'APPOINTMENT',
  sortOrder: 3,
  isActive: true,
  isCustomPriced: false,
  features: ['Bookings', 'Reminders'],
};

const COMMERCE_PRO_TIER = {
  id: 'tier_ecom_professional',
  slug: 'ecom-professional',
  name: 'Commerce Pro',
  vertical: 'ECOMMERCE',
  sortOrder: 3,
  isActive: true,
  isCustomPriced: false,
  features: ['Products', 'Orders'],
};

function paidPrice(overrides = {}) {
  return {
    id: 'price_1',
    tierId: PROFESSIONAL_TIER.id,
    countryCode: 'US',
    currencyCode: 'USD',
    amountMonthlyMinor: 4900,
    amountAnnualMinor: 49000,
    paddlePriceIdMonthly: 'pri_professional_month',
    paddlePriceIdAnnual: 'pri_professional_year',
    ...overrides,
  };
}

describe('billing change preview', () => {
  const originalMultiGateway = process.env.BILLING_MULTI_GATEWAY;
  const originalStripeSecret = process.env.STRIPE_SECRET_KEY;
  const originalRazorpayKey = process.env.RAZORPAY_KEY_ID;
  const originalRazorpaySecret = process.env.RAZORPAY_KEY_SECRET;

  afterAll(() => {
    if (originalMultiGateway === undefined) delete process.env.BILLING_MULTI_GATEWAY;
    else process.env.BILLING_MULTI_GATEWAY = originalMultiGateway;
    if (originalStripeSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalStripeSecret;
    if (originalRazorpayKey === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = originalRazorpayKey;
    if (originalRazorpaySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = originalRazorpaySecret;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BILLING_MULTI_GATEWAY;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;

    prisma.business.findUnique.mockResolvedValue({
      id: 'biz_1',
      vertical: 'APPOINTMENT',
      country: 'CA',
      billingCountry: 'US',
    });
    prisma.subscription.findUnique.mockResolvedValue({
      id: 'sub_local_1',
      businessId: 'biz_1',
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      tier: CURRENT_TIER,
      paddleSubscriptionId: 'sub_paddle_1',
      pendingTierSlug: null,
      pendingBillingCycle: null,
      pendingChangeEffectiveAt: null,
    });
    prisma.pricingTier.findUnique.mockResolvedValue(PROFESSIONAL_TIER);
    resolveTierPriceRecord.mockResolvedValue(paidPrice());
    isPaddleConfigured.mockReturnValue(true);

    prisma.service.count.mockResolvedValue(0);
    prisma.appointment.count.mockResolvedValue(0);
    prisma.staffSchedule.count.mockResolvedValue(0);
    prisma.product.count.mockResolvedValue(0);
    prisma.order.count.mockResolvedValue(0);
    prisma.productCategory.count.mockResolvedValue(0);
  });

  test('previews paid Paddle subscription updates using the stored billing country', async () => {
    const preview = await buildBillingChangePreview({
      businessId: 'biz_1',
      tierSlug: 'professional',
      billingCycle: 'YEARLY',
    });

    expect(resolveTierPriceRecord).toHaveBeenCalledWith({
      tierId: 'tier_professional',
      countryCode: 'US',
    });
    expect(preview.target.direction).toBe('upgrade');
    expect(preview.money).toEqual(expect.objectContaining({
      priceId: 'pri_professional_year',
      currencyCode: 'USD',
      expectedAmountMinor: 49000,
      requiresCheckout: false,
      willUpdatePaddleSubscription: true,
      prorationBillingMode: 'prorated_immediately',
      taxMode: 'paddle_merchant_of_record',
    }));
    expect(preview.safeToCommit).toBe(true);
  });

  test('previews trialing subscription updates with Paddle-safe do_not_bill proration', async () => {
    prisma.subscription.findUnique.mockResolvedValue({
      id: 'sub_local_1',
      businessId: 'biz_1',
      status: 'TRIALING',
      billingCycle: 'MONTHLY',
      tier: CURRENT_TIER,
      paddleSubscriptionId: 'sub_paddle_1',
      pendingTierSlug: null,
      pendingBillingCycle: null,
      pendingChangeEffectiveAt: null,
    });

    const preview = await buildBillingChangePreview({
      businessId: 'biz_1',
      tierSlug: 'professional',
      billingCycle: 'MONTHLY',
    });

    expect(preview.money).toEqual(expect.objectContaining({
      requiresCheckout: false,
      willUpdatePaddleSubscription: true,
      prorationBillingMode: 'do_not_bill',
    }));
    expect(preview.safeToCommit).toBe(true);
  });

  test('previews paid downgrades as renewal-scheduled with no immediate billing', async () => {
    prisma.subscription.findUnique.mockResolvedValue({
      id: 'sub_local_1',
      businessId: 'biz_1',
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      tier: PROFESSIONAL_TIER,
      paddleSubscriptionId: 'sub_paddle_1',
      pendingTierSlug: null,
      pendingBillingCycle: null,
      pendingChangeEffectiveAt: null,
    });
    prisma.pricingTier.findUnique.mockResolvedValue(CURRENT_TIER);
    resolveTierPriceRecord.mockResolvedValue(paidPrice({
      tierId: CURRENT_TIER.id,
      paddlePriceIdMonthly: 'pri_starter_month',
      paddlePriceIdAnnual: 'pri_starter_year',
    }));

    const preview = await buildBillingChangePreview({
      businessId: 'biz_1',
      tierSlug: 'starter',
      billingCycle: 'MONTHLY',
    });

    expect(preview.target.direction).toBe('downgrade');
    expect(preview.money).toEqual(expect.objectContaining({
      requiresCheckout: false,
      willUpdatePaddleSubscription: true,
      willScheduleDowngrade: true,
      changeTiming: 'period_end',
      prorationBillingMode: 'do_not_bill',
    }));
    expect(preview.money.finalAmountNote).toMatch(/no immediate charge or credit/i);
    expect(preview.safeToCommit).toBe(true);
  });

  test('previews cross-vertical impact but blocks business-type switching', async () => {
    prisma.subscription.findUnique.mockResolvedValue({
      id: 'sub_local_1',
      businessId: 'biz_1',
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      tier: CURRENT_TIER,
      paddleSubscriptionId: null,
      pendingTierSlug: null,
      pendingBillingCycle: null,
      pendingChangeEffectiveAt: null,
    });
    prisma.pricingTier.findUnique.mockResolvedValue(COMMERCE_PRO_TIER);
    resolveTierPriceRecord.mockResolvedValue(paidPrice({
      tierId: COMMERCE_PRO_TIER.id,
      paddlePriceIdMonthly: 'pri_commerce_month',
    }));
    prisma.service.count.mockResolvedValue(3);
    prisma.appointment.count.mockResolvedValue(7);
    prisma.staffSchedule.count.mockResolvedValue(2);

    const preview = await buildBillingChangePreview({
      businessId: 'biz_1',
      tierSlug: 'ecom-professional',
      targetVertical: 'ECOMMERCE',
      billingCycle: 'MONTHLY',
    });

    expect(preview.impact).toEqual(expect.objectContaining({
      currentVertical: 'APPOINTMENT',
      targetVertical: 'ECOMMERCE',
      hidden: { services: 3, appointments: 7, schedules: 2 },
      noOp: false,
    }));
    expect(preview.impact.gained).toEqual(expect.arrayContaining(['Online store', 'Order management']));
    expect(preview.money.requiresCheckout).toBe(true);
    expect(preview.money.willUpdatePaddleSubscription).toBe(false);
    expect(preview.safeToCommit).toBe(false);
    expect(preview.blocking).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'VERTICAL_SWITCH_DISABLED' }),
    ]));
  });

  test('blocks paid plan changes when the selected Paddle price ID is missing', async () => {
    resolveTierPriceRecord.mockResolvedValue(paidPrice({
      paddlePriceIdMonthly: null,
    }));

    const preview = await buildBillingChangePreview({
      businessId: 'biz_1',
      tierSlug: 'professional',
      billingCycle: 'MONTHLY',
    });

    expect(preview.money.priceIdConfigured).toBe(false);
    expect(preview.safeToCommit).toBe(false);
    expect(preview.blocking).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PADDLE_PRICE_ID_MISSING' }),
    ]));
  });

  test('blocks non-free self-serve plans when the local price record is missing', async () => {
    resolveTierPriceRecord.mockResolvedValue(null);

    const preview = await buildBillingChangePreview({
      businessId: 'biz_1',
      tierSlug: 'professional',
      billingCycle: 'MONTHLY',
    });

    expect(preview.money.expectedAmountSource).toBe('missing');
    expect(preview.money.paidTarget).toBe(true);
    expect(preview.safeToCommit).toBe(false);
    expect(preview.blocking).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PRICE_RECORD_MISSING' }),
      expect.objectContaining({ code: 'PADDLE_PRICE_ID_MISSING' }),
    ]));
  });

  test('previews New Zealand SaaS subscriptions through Stripe', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_nz';
    prisma.business.findUnique.mockResolvedValue({
      id: 'biz_1',
      vertical: 'APPOINTMENT',
      country: 'US',
      billingCountry: 'NZ',
    });
    prisma.subscription.findUnique.mockResolvedValue({
      id: 'sub_local_1',
      businessId: 'biz_1',
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      tier: CURRENT_TIER,
      stripeSubscriptionId: 'sub_stripe_nz_1',
      pendingTierSlug: null,
      pendingBillingCycle: null,
      pendingChangeEffectiveAt: null,
    });
    resolveTierPriceRecord.mockResolvedValue(paidPrice({
      countryCode: 'NZ',
      currencyCode: 'NZD',
      amountMonthlyMinor: 7900,
      stripePriceIdMonthly: 'price_professional_month_nz',
    }));

    const preview = await buildBillingChangePreview({
      businessId: 'biz_1',
      tierSlug: 'professional',
      billingCycle: 'MONTHLY',
    });

    expect(resolveTierPriceRecord).toHaveBeenCalledWith({
      tierId: 'tier_professional',
      countryCode: 'NZ',
    });
    expect(preview.money).toEqual(expect.objectContaining({
      gateway: 'STRIPE',
      priceId: 'price_professional_month_nz',
      currencyCode: 'NZD',
      requiresCheckout: false,
      willUpdateGatewaySubscription: true,
      willUpdatePaddleSubscription: false,
      prorationBillingMode: 'always_invoice',
      taxMode: 'sitepresso_merchant_of_record',
    }));
    expect(preview.current.activeGateway).toBe('STRIPE');
    expect(preview.safeToCommit).toBe(true);
  });

  test('previews India SaaS subscriptions through Razorpay, not Paddle or Stripe', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
    prisma.business.findUnique.mockResolvedValue({
      id: 'biz_1',
      vertical: 'APPOINTMENT',
      country: 'US',
      billingCountry: 'IN',
    });
    prisma.subscription.findUnique.mockResolvedValue({
      id: 'sub_local_1',
      businessId: 'biz_1',
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      tier: CURRENT_TIER,
      razorpaySubscriptionId: 'sub_razorpay_1',
      pendingTierSlug: null,
      pendingBillingCycle: null,
      pendingChangeEffectiveAt: null,
    });
    resolveTierPriceRecord.mockResolvedValue(paidPrice({
      countryCode: 'IN',
      currencyCode: 'INR',
      amountMonthlyMinor: 199900,
      razorpayPlanIdMonthly: 'plan_professional_month_in',
    }));

    const preview = await buildBillingChangePreview({
      businessId: 'biz_1',
      tierSlug: 'professional',
      billingCycle: 'MONTHLY',
    });

    expect(resolveTierPriceRecord).toHaveBeenCalledWith({
      tierId: 'tier_professional',
      countryCode: 'IN',
    });
    expect(preview.money).toEqual(expect.objectContaining({
      gateway: 'RAZORPAY',
      priceId: 'plan_professional_month_in',
      currencyCode: 'INR',
      requiresCheckout: false,
      willUpdateGatewaySubscription: true,
      willUpdatePaddleSubscription: false,
      prorationBillingMode: 'schedule_now',
      taxMode: 'sitepresso_merchant_of_record',
    }));
    expect(preview.current.activeGateway).toBe('RAZORPAY');
    expect(preview.safeToCommit).toBe(true);
  });

  test('an EXISTING Paddle subscriber changes plans on Paddle (no forced gateway migration), even with an India billing country', async () => {
    // Regression guard: previously this returned RAZORPAY + a GATEWAY_MIGRATION_REQUIRED
    // block, which dead-ended every Paddle tenant whose country routes elsewhere.
    // You don't migrate gateways just to change plan — honor the active one.
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
    prisma.business.findUnique.mockResolvedValue({
      id: 'biz_1',
      vertical: 'APPOINTMENT',
      country: 'US',
      billingCountry: 'IN',
    });
    resolveTierPriceRecord.mockResolvedValue(paidPrice({
      countryCode: 'IN',
      currencyCode: 'INR',
      amountMonthlyMinor: 199900,
      razorpayPlanIdMonthly: 'plan_professional_month_in',
      // paddlePriceIdMonthly kept from paidPrice() default — the gateway it's on.
    }));

    const preview = await buildBillingChangePreview({
      businessId: 'biz_1',
      tierSlug: 'professional',
      billingCycle: 'MONTHLY',
    });

    expect(preview.money.gateway).toBe('PADDLE');
    expect(preview.money.gatewayMigrationRequired).toBe(false);
    expect(preview.money.priceId).toBe('pri_professional_month');
    expect(preview.money.willUpdatePaddleSubscription).toBe(true);
    expect(preview.safeToCommit).toBe(true);
  });

  test('a NEW subscriber (no active gateway) in India still routes to Razorpay', async () => {
    // The India→Razorpay design is preserved for brand-new subscriptions —
    // only EXISTING subscriptions are pinned to their current gateway.
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
    prisma.business.findUnique.mockResolvedValue({
      id: 'biz_1',
      vertical: 'APPOINTMENT',
      country: 'US',
      billingCountry: 'IN',
    });
    prisma.subscription.findUnique.mockResolvedValue({
      id: 'sub_local_1',
      businessId: 'biz_1',
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      tier: CURRENT_TIER,
      paddleSubscriptionId: null,
      stripeSubscriptionId: null,
      razorpaySubscriptionId: null,
      pendingTierSlug: null,
      pendingBillingCycle: null,
      pendingChangeEffectiveAt: null,
    });
    resolveTierPriceRecord.mockResolvedValue(paidPrice({
      countryCode: 'IN',
      currencyCode: 'INR',
      amountMonthlyMinor: 199900,
      razorpayPlanIdMonthly: 'plan_professional_month_in',
    }));

    const preview = await buildBillingChangePreview({
      businessId: 'biz_1',
      tierSlug: 'professional',
      billingCycle: 'MONTHLY',
    });

    expect(preview.money.gateway).toBe('RAZORPAY');
    expect(preview.money.priceId).toBe('plan_professional_month_in');
    expect(preview.safeToCommit).toBe(true);
  });
});
