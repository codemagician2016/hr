jest.mock('../src/core/lib/prisma', () => ({
  $transaction: jest.fn(),
  business: {
    update: jest.fn(),
  },
  subscription: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  pricingTier: {
    findUnique: jest.fn(),
  },
  tierPrice: {
    findFirst: jest.fn(),
  },
}));

const prisma = require('../src/core/lib/prisma');
const { syncBusinessSubscriptionFromPaddle } = require('../src/core/lib/subscriptionBilling');

describe('subscriptionBilling Paddle sync', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(async (operations) => Promise.all(operations));
  });

  test('marks an active paid Paddle subscription as trial-converted', async () => {
    const existing = {
      id: 'sub-local-1',
      businessId: 'biz_1',
      tierId: 'tier_free',
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
      paddleCustomerId: 'ctm_existing',
      paddleSubscriptionId: null,
      paddleTransactionId: null,
      pendingTierSlug: null,
      trialConvertedAt: null,
    };

    prisma.subscription.findUnique.mockResolvedValue(existing);
    prisma.tierPrice.findFirst.mockResolvedValue({
      paddlePriceIdMonthly: 'pri_starter_monthly',
      paddlePriceIdAnnual: 'pri_starter_annual',
      tier: { id: 'tier_starter', slug: 'starter', name: 'Starter' },
    });
    prisma.subscription.update.mockImplementation(async ({ data }) => ({
      ...existing,
      ...data,
      tier: { id: 'tier_starter', slug: 'starter', name: 'Starter' },
    }));

    await syncBusinessSubscriptionFromPaddle({
      businessId: 'biz_1',
      paddleTransactionId: 'txn_paid_1',
      paddleSubscription: {
        id: 'sub_paddle_1',
        status: 'active',
        customer_id: 'ctm_1',
        current_billing_period: { ends_at: '2026-07-01T00:00:00Z' },
        items: [{ price: { id: 'pri_starter_monthly' } }],
      },
    });

    expect(prisma.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { businessId: 'biz_1' },
      data: expect.objectContaining({
        tierId: 'tier_starter',
        status: 'ACTIVE',
        paddleSubscriptionId: 'sub_paddle_1',
        paddleTransactionId: 'txn_paid_1',
        trialConvertedAt: expect.any(Date),
      }),
    }));
  });

  test('does not mark trial-converted for an unpaid past-due Paddle subscription', async () => {
    const existing = {
      id: 'sub-local-2',
      businessId: 'biz_2',
      tierId: 'tier_free',
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
      paddleCustomerId: 'ctm_existing',
      paddleSubscriptionId: null,
      paddleTransactionId: null,
      pendingTierSlug: null,
      trialConvertedAt: null,
    };

    prisma.subscription.findUnique.mockResolvedValue(existing);
    prisma.pricingTier.findUnique.mockResolvedValue({ id: 'tier_free', slug: 'free', name: 'Free' });
    prisma.tierPrice.findFirst.mockResolvedValue({
      paddlePriceIdMonthly: 'pri_starter_monthly',
      paddlePriceIdAnnual: 'pri_starter_annual',
      tier: { id: 'tier_starter', slug: 'starter', name: 'Starter' },
    });
    prisma.subscription.update.mockImplementation(async ({ data }) => ({
      ...existing,
      ...data,
      tier: { id: 'tier_starter', slug: 'starter', name: 'Starter' },
    }));

    await syncBusinessSubscriptionFromPaddle({
      businessId: 'biz_2',
      paddleSubscription: {
        id: 'sub_paddle_2',
        status: 'past_due',
        customer_id: 'ctm_2',
        current_billing_period: { ends_at: '2026-07-01T00:00:00Z' },
        items: [{ price: { id: 'pri_starter_monthly' } }],
      },
    });

    expect(prisma.subscription.update.mock.calls[0][0].data).not.toHaveProperty('trialConvertedAt');
    expect(prisma.subscription.update.mock.calls[0][0].data).toEqual(expect.objectContaining({
      tierId: 'tier_free',
      status: 'PAST_DUE',
      pastDueSince: expect.any(Date),
      accessGraceUntil: null,
    }));
  });

  test('paused paid Paddle subscriptions keep a distinct paused lifecycle state', async () => {
    const existing = {
      id: 'sub-local-3',
      businessId: 'biz_3',
      tierId: 'tier_starter',
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
      paddleCustomerId: 'ctm_existing',
      paddleSubscriptionId: 'sub_paddle_3',
      paddleTransactionId: 'txn_paid_3',
      pendingTierSlug: null,
      trialConvertedAt: new Date('2026-05-01T00:00:00Z'),
    };

    prisma.subscription.findUnique.mockResolvedValue(existing);
    prisma.pricingTier.findUnique.mockResolvedValue({ id: 'tier_free', slug: 'free', name: 'Free' });
    prisma.tierPrice.findFirst.mockResolvedValue({
      paddlePriceIdMonthly: 'pri_starter_monthly',
      paddlePriceIdAnnual: 'pri_starter_annual',
      tier: { id: 'tier_starter', slug: 'starter', name: 'Starter' },
    });
    prisma.subscription.update.mockImplementation(async ({ data }) => ({
      ...existing,
      ...data,
      tier: data.tierId === 'tier_free'
        ? { id: 'tier_free', slug: 'free', name: 'Free' }
        : { id: 'tier_starter', slug: 'starter', name: 'Starter' },
    }));

    await syncBusinessSubscriptionFromPaddle({
      businessId: 'biz_3',
      paddleSubscription: {
        id: 'sub_paddle_3',
        status: 'paused',
        customer_id: 'ctm_existing',
        current_billing_period: { ends_at: '2026-07-01T00:00:00Z' },
        items: [{ price: { id: 'pri_starter_monthly' } }],
      },
    });

    expect(prisma.subscription.update.mock.calls[0][0].data).toEqual(expect.objectContaining({
      tierId: 'tier_free',
      status: 'PAUSED',
    }));
  });

  test('ignores stale Paddle subscription events older than the last processed event', async () => {
    const existing = {
      id: 'sub-local-4',
      businessId: 'biz_4',
      tierId: 'tier_free',
      status: 'CANCELLED',
      billingCycle: 'MONTHLY',
      currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
      paddleCustomerId: 'ctm_existing',
      paddleSubscriptionId: null,
      paddleTransactionId: 'txn_old',
      pendingTierSlug: null,
      trialConvertedAt: new Date('2026-05-01T00:00:00Z'),
      lastPaddleEventAt: new Date('2026-06-03T10:00:00Z'),
    };

    prisma.subscription.findUnique.mockResolvedValue(existing);

    const result = await syncBusinessSubscriptionFromPaddle({
      businessId: 'biz_4',
      paddleEventOccurredAt: '2026-06-03T09:00:00Z',
      paddleEventId: 'evt_old',
      paddleSubscription: {
        id: 'sub_paddle_4',
        status: 'active',
        customer_id: 'ctm_existing',
        current_billing_period: { ends_at: '2026-07-01T00:00:00Z' },
        items: [{ price: { id: 'pri_starter_monthly' } }],
      },
    });

    expect(prisma.subscription.update).not.toHaveBeenCalled();
    expect(result.stalePaddleEventIgnored).toBe(true);
  });

  test('does not apply legacy pending business type after Paddle confirms a paid tier', async () => {
    const existing = {
      id: 'sub-local-5',
      businessId: 'biz_5',
      tierId: 'tier_starter',
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
      paddleCustomerId: 'ctm_existing',
      paddleSubscriptionId: 'sub_paddle_5',
      paddleTransactionId: 'txn_old',
      pendingTierSlug: 'ecom-professional',
      pendingVertical: 'ECOMMERCE',
      trialConvertedAt: new Date('2026-05-01T00:00:00Z'),
    };

    prisma.subscription.findUnique.mockResolvedValue(existing);
    prisma.tierPrice.findFirst.mockResolvedValue({
      paddlePriceIdMonthly: 'pri_ecom_professional_monthly',
      paddlePriceIdAnnual: 'pri_ecom_professional_annual',
      tier: {
        id: 'tier_ecom_professional',
        slug: 'ecom-professional',
        name: 'Commerce Pro',
        vertical: 'ECOMMERCE',
      },
    });
    prisma.subscription.update.mockImplementation(async ({ data }) => ({
      ...existing,
      ...data,
      tier: {
        id: 'tier_ecom_professional',
        slug: 'ecom-professional',
        name: 'Commerce Pro',
        vertical: 'ECOMMERCE',
      },
    }));
    prisma.business.update.mockResolvedValue({ id: 'biz_5', vertical: 'ECOMMERCE' });

    await syncBusinessSubscriptionFromPaddle({
      businessId: 'biz_5',
      paddleSubscription: {
        id: 'sub_paddle_5',
        status: 'active',
        customer_id: 'ctm_existing',
        current_billing_period: { ends_at: '2026-07-01T00:00:00Z' },
        items: [{ price: { id: 'pri_ecom_professional_monthly' } }],
      },
    });

    expect(prisma.subscription.update.mock.calls[0][0].data).toEqual(expect.objectContaining({
      tierId: 'tier_ecom_professional',
      pendingTierSlug: null,
      pendingVertical: null,
    }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.business.update).not.toHaveBeenCalled();
  });

  test('keeps current entitlements while a paid downgrade is pending for the future', async () => {
    const future = new Date('2099-01-01T00:00:00Z');
    const existing = {
      id: 'sub-local-6',
      businessId: 'biz_6',
      tierId: 'tier_professional',
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      currentPeriodEnd: future,
      paddleCustomerId: 'ctm_existing',
      paddleSubscriptionId: 'sub_paddle_6',
      paddleTransactionId: 'txn_old',
      pendingTierSlug: 'starter',
      pendingBillingCycle: 'MONTHLY',
      pendingChangeEffectiveAt: future,
      pendingVertical: null,
      trialConvertedAt: new Date('2026-05-01T00:00:00Z'),
    };

    prisma.subscription.findUnique.mockResolvedValue(existing);
    prisma.tierPrice.findFirst.mockResolvedValue({
      paddlePriceIdMonthly: 'pri_starter_monthly',
      paddlePriceIdAnnual: 'pri_starter_annual',
      tier: { id: 'tier_starter', slug: 'starter', name: 'Starter' },
    });
    prisma.subscription.update.mockImplementation(async ({ data }) => ({
      ...existing,
      ...data,
      tier: data.tierId === 'tier_professional'
        ? { id: 'tier_professional', slug: 'professional', name: 'Professional' }
        : { id: 'tier_starter', slug: 'starter', name: 'Starter' },
    }));

    await syncBusinessSubscriptionFromPaddle({
      businessId: 'biz_6',
      paddleSubscription: {
        id: 'sub_paddle_6',
        status: 'active',
        customer_id: 'ctm_existing',
        current_billing_period: { ends_at: '2099-01-01T00:00:00Z' },
        items: [{ price: { id: 'pri_starter_monthly' } }],
      },
    });

    expect(prisma.subscription.update.mock.calls[0][0].data).toEqual(expect.objectContaining({
      tierId: 'tier_professional',
      billingCycle: 'MONTHLY',
      pendingTierSlug: 'starter',
      pendingBillingCycle: 'MONTHLY',
      pendingChangeEffectiveAt: future,
    }));
  });
});
