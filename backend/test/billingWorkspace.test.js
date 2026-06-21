jest.mock('../src/core/lib/prisma', () => ({
  business: {
    findUnique: jest.fn(),
  },
  subscription: {
    findUnique: jest.fn(),
  },
  pricingTier: {
    findMany: jest.fn(),
  },
  tierPrice: {
    findMany: jest.fn(),
  },
  countryZoneAssignment: {
    findUnique: jest.fn(),
  },
  adminCouponRedemption: {
    findMany: jest.fn(),
  },
  pricingAuditLog: {
    findMany: jest.fn(),
  },
  paddleWebhookEvent: {
    findMany: jest.fn(),
  },
}));

jest.mock('../src/core/lib/paddle', () => ({
  getPaddleEnvironment: jest.fn(() => 'sandbox'),
  getPaddleSubscription: jest.fn(),
  isPaddleConfigured: jest.fn(() => false),
  listPaddleTransactions: jest.fn(),
}));

jest.mock('../src/core/lib/paddleBillingViews', () => ({
  buildBillingContext: jest.fn(),
  extractAfterCursor: jest.fn(),
  serializeBillingTransaction: jest.fn(),
}));

const prisma = require('../src/core/lib/prisma');
const { listPaddleTransactions } = require('../src/core/lib/paddle');
const {
  buildBillingWorkspace,
  planFamilyKeyForTier,
} = require('../src/core/lib/billingWorkspace');

const TIERS = [
  { id: 'tier_free', slug: 'free', vertical: 'APPOINTMENT', name: 'Free', sortOrder: 0, isActive: true, features: [] },
  { id: 'tier_solo', slug: 'solo', vertical: 'APPOINTMENT', name: 'Solo', sortOrder: 1, isActive: true, features: [] },
  { id: 'tier_starter', slug: 'starter', vertical: 'APPOINTMENT', name: 'Starter', sortOrder: 2, isActive: true, features: [] },
  { id: 'tier_professional', slug: 'professional', vertical: 'APPOINTMENT', name: 'Professional', sortOrder: 3, isActive: true, features: [] },
  { id: 'tier_static_free', slug: 'static-free', vertical: 'STATIC', name: 'Solo', sortOrder: 1, isActive: true, features: [] },
  { id: 'tier_static_professional', slug: 'static-professional', vertical: 'STATIC', name: 'Professional', sortOrder: 3, isActive: true, features: [] },
  { id: 'tier_ecom_free', slug: 'ecom-free', vertical: 'ECOMMERCE', name: 'Starter Commerce', sortOrder: 1, isActive: true, features: [] },
  { id: 'tier_ecom_professional', slug: 'ecom-professional', vertical: 'ECOMMERCE', name: 'Commerce Pro', sortOrder: 3, isActive: true, features: [] },
];

function price(tierId, monthly) {
  return {
    id: `price_${tierId}`,
    tierId,
    countryCode: null,
    currencyCode: 'USD',
    amountMonthlyMinor: monthly,
    amountAnnualMinor: monthly * 10,
    paddlePriceIdMonthly: `pri_${tierId}_monthly`,
    paddlePriceIdAnnual: `pri_${tierId}_annual`,
  };
}

describe('billing workspace read model', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.business.findUnique.mockResolvedValue({
      id: 'biz_1',
      name: 'Bright Smile',
      slug: 'bright-smile',
      vertical: 'APPOINTMENT',
      country: 'US',
      defaultCurrency: 'USD',
      category: 'dentist',
      billingPurchaserType: 'BUSINESS',
      billingBusinessName: 'Bright Smile LLC',
      billingContactName: 'Owner',
      billingEmail: 'owner@example.test',
      billingTaxId: '',
      billingAddressLine1: '1 Main St',
      billingAddressLine2: '',
      billingCity: 'Austin',
      billingState: 'TX',
      billingPostalCode: '78701',
      billingCountry: 'US',
      createdAt: new Date('2026-06-01T00:00:00Z'),
      updatedAt: new Date('2026-06-02T00:00:00Z'),
    });
    prisma.subscription.findUnique.mockResolvedValue({
      id: 'sub_local_1',
      businessId: 'biz_1',
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      tier: TIERS.find((tier) => tier.slug === 'professional'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
      pendingTierSlug: 'ecom-professional',
      pendingBillingCycle: 'YEARLY',
      pendingChangeEffectiveAt: new Date('2026-07-01T00:00:00Z'),
      paddleCustomerId: 'ctm_1',
      paddleSubscriptionId: 'sub_paddle_1',
      paddleTransactionId: 'txn_1',
      lastPaddleEventId: 'evt_latest',
      lastPaddleEventAt: new Date('2026-06-03T00:00:00Z'),
      pastDueSince: null,
      accessGraceUntil: null,
      trialStartedAt: null,
      trialEndsAt: null,
      trialConvertedAt: new Date('2026-06-01T00:00:00Z'),
      trialPlanSlug: 'professional',
      createdAt: new Date('2026-06-01T00:00:00Z'),
      updatedAt: new Date('2026-06-03T00:00:00Z'),
    });
    prisma.pricingTier.findMany.mockResolvedValue(TIERS);
    prisma.tierPrice.findMany.mockResolvedValue(TIERS.map((tier, i) => price(tier.id, i * 1000)));
    prisma.countryZoneAssignment.findUnique.mockResolvedValue({
      countryCode: 'US',
      countryName: 'United States',
      currencyCode: 'USD',
      currencySymbol: '$',
      zone: { slug: 'zone-1', name: 'Premium markets', multiplier: '1.0000' },
    });
    prisma.adminCouponRedemption.findMany.mockResolvedValue([{
      id: 'redemption_1',
      createdAt: new Date('2026-06-02T01:00:00Z'),
      appliedFreeDays: 30,
      benefitSnapshot: { benefitType: 'FREE_PERIOD' },
      coupon: {
        code: 'LAUNCH30',
        benefitType: 'FREE_PERIOD',
        benefitValue: 30,
        benefitUnit: 'DAYS',
        benefitCurrency: null,
      },
    }]);
    prisma.pricingAuditLog.findMany.mockResolvedValue([{
      id: 'audit_1',
      entityType: 'subscription',
      entityId: 'biz_1',
      action: 'UPDATED',
      changedBy: 'user_1',
      oldValue: null,
      newValue: { event: 'plan_select_country_resolved', tierSlug: 'professional' },
      note: 'VPN-lock: zone derived from Business.country, not client hint',
      createdAt: new Date('2026-06-02T02:00:00Z'),
    }]);
    prisma.paddleWebhookEvent.findMany.mockResolvedValue([{
      id: 'pwe_1',
      eventId: 'evt_1',
      eventType: 'transaction.completed',
      status: 'PROCESSED',
      objectId: 'txn_1',
      attempts: 1,
      occurredAt: new Date('2026-06-02T03:00:00Z'),
      createdAt: new Date('2026-06-02T03:01:00Z'),
    }]);
  });

  test('maps legacy vertical tier slugs into customer-facing plan families', () => {
    expect(planFamilyKeyForTier(TIERS.find((tier) => tier.slug === 'free'))).toBe('FREE');
    expect(planFamilyKeyForTier(TIERS.find((tier) => tier.slug === 'static-free'))).toBe('SOLO');
    expect(planFamilyKeyForTier(TIERS.find((tier) => tier.slug === 'ecom-free'))).toBe('STARTER');
    expect(planFamilyKeyForTier(TIERS.find((tier) => tier.slug === 'ecom-professional'))).toBe('PROFESSIONAL');
  });

  test('builds one workspace with vertical windows, pending state, and timeline events', async () => {
    const workspace = await buildBillingWorkspace({ businessId: 'biz_1' });

    expect(workspace.version).toBe(1);
    expect(workspace.business.vertical).toBe('APPOINTMENT');
    expect(workspace.subscription.pendingChange).toEqual(expect.objectContaining({
      tierSlug: 'ecom-professional',
      billingCycle: 'YEARLY',
    }));
    expect(workspace.catalog.currentFamilyKey).toBe('PROFESSIONAL');

    const ecomWindow = workspace.catalog.verticalWindows.find((window) => window.key === 'ECOMMERCE');
    expect(ecomWindow.recommendedPlanSlug).toBe('ecom-professional');
    expect(ecomWindow.hasCurrentFamilyEquivalent).toBe(true);

    const eventTypes = workspace.history.events.map((item) => item.type);
    expect(eventTypes).toEqual(expect.arrayContaining([
      'subscription.pending_change',
      'coupon.redeemed',
      'pricing.audit',
      'paddle.webhook',
    ]));
    expect(workspace.workspace.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PENDING_PLAN_CHANGE' }),
    ]));
    expect(listPaddleTransactions).not.toHaveBeenCalled();
  });
});
