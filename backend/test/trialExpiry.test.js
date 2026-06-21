// Tests for the processTrialExpiry cron task. Mocks Prisma so tests
// don't hit real DB.

jest.mock('../src/core/lib/prisma', () => ({
  subscription: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
  pricingTier: {
    findFirst: jest.fn(),
  },
  appointment: { findMany: jest.fn(), update: jest.fn() },
  emailDelivery: { findMany: jest.fn() },
  user: { findFirst: jest.fn(), findMany: jest.fn() },
}));

const prisma = require('../src/core/lib/prisma');
const { processTrialExpiry } = require('../src/core/lib/scheduler');

const FREE_TIER = { id: 'free-tier-id', slug: 'free' };
const PAST = new Date(Date.now() - 60 * 60 * 1000);  // 1h ago
const FUTURE = new Date(Date.now() + 60 * 60 * 1000); // 1h from now

beforeEach(() => {
  prisma.subscription.findMany.mockReset();
  prisma.subscription.update.mockReset();
  prisma.pricingTier.findFirst.mockReset();
  prisma.pricingTier.findFirst.mockResolvedValue(FREE_TIER);
});

describe('processTrialExpiry', () => {
  test('downgrades subscription with expired trial to Free tier', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([
      {
        id: 'sub-1',
        tierId: 'pro-tier',
        tier: { slug: 'professional' },
        business: { id: 'biz-1', name: 'Acme' },
        trialEndsAt: PAST,
        trialConvertedAt: null,
      },
    ]);
    prisma.subscription.update.mockResolvedValue({});

    await processTrialExpiry();

    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'sub-1' },
      data: { tierId: FREE_TIER.id },
    });
  });

  test('does NOT downgrade subscriptions still in trial', async () => {
    // Future trial — query filters by trialEndsAt < now, so this shouldn't
    // even appear in findMany results. Simulate that.
    prisma.subscription.findMany.mockResolvedValueOnce([]);
    await processTrialExpiry();
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  test('does NOT downgrade converted subscriptions (already paid)', async () => {
    // Filter excludes trialConvertedAt != null. Empty findMany result.
    prisma.subscription.findMany.mockResolvedValueOnce([]);
    await processTrialExpiry();
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  test('skips downgrade when sub is already on Free', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([
      {
        id: 'sub-2',
        tierId: FREE_TIER.id,
        tier: { slug: 'free' },
        business: { name: 'Acme' },
        trialEndsAt: PAST,
        trialConvertedAt: null,
      },
    ]);

    await processTrialExpiry();

    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  test('only downgrades GATEWAY-LESS trials — excludes Paddle/Stripe/Razorpay-backed trials (B2)', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([]);
    await processTrialExpiry();
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        trialConvertedAt: null,
        paddleSubscriptionId: null,
        stripeSubscriptionId: null,
        razorpaySubscriptionId: null,
      }),
    }));
  });

  test('aborts gracefully if Free tier missing in DB', async () => {
    // "Missing" means neither the vertical-specific free tier nor the generic
    // 'free' fallback exists — so null for ALL lookups, not just the first.
    prisma.pricingTier.findFirst.mockResolvedValue(null);
    prisma.subscription.findMany.mockResolvedValueOnce([
      { id: 'sub-3', tier: { slug: 'starter' }, business: { name: 'X' }, trialEndsAt: PAST, trialConvertedAt: null },
    ]);

    await processTrialExpiry();

    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  test('handles individual update failures without aborting the whole batch', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([
      { id: 'sub-A', tierId: 't1', tier: { slug: 'starter' }, business: { name: 'A' }, trialEndsAt: PAST, trialConvertedAt: null },
      { id: 'sub-B', tierId: 't2', tier: { slug: 'professional' }, business: { name: 'B' }, trialEndsAt: PAST, trialConvertedAt: null },
    ]);
    // First update fails, second succeeds
    prisma.subscription.update
      .mockRejectedValueOnce(new Error('lock timeout'))
      .mockResolvedValueOnce({});

    await processTrialExpiry();

    expect(prisma.subscription.update).toHaveBeenCalledTimes(2);
  });

  test('queries with trialEndsAt < now AND trialConvertedAt = null', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([]);
    await processTrialExpiry();
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trialEndsAt: expect.objectContaining({ lt: expect.any(Date) }),
          trialConvertedAt: null,
        }),
      }),
    );
  });
});
