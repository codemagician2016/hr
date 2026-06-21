// syncBusinessSubscriptionFromGatewayEvent — the shared Stripe/Razorpay applier.
// Starts coverage of the biggest hole in the suite. This batch focuses on B4:
// a cancel→free downgrade must land on the vertical-correct free tier
// (free / static-free / ecom-free), never always APPOINTMENT 'free'.

const mockPrisma = {
  subscription: { findUnique: jest.fn(), update: jest.fn() },
  business: { findUnique: jest.fn() },
  pricingTier: { findUnique: jest.fn() },
  tierPrice: { findFirst: jest.fn() },
};
jest.mock('../src/core/lib/prisma', () => mockPrisma);

const { syncBusinessSubscriptionFromGatewayEvent } = require('../src/core/lib/subscriptionBilling');

const FREE_TIERS = {
  free: { id: 'free-id', slug: 'free' },
  'static-free': { id: 'static-free-id', slug: 'static-free' },
  'ecom-free': { id: 'ecom-free-id', slug: 'ecom-free' },
};

beforeEach(() => {
  jest.clearAllMocks();
  // Existing PAID subscription on a gateway.
  mockPrisma.subscription.findUnique.mockResolvedValue({
    businessId: 'biz1', tierId: 'paid-tier', status: 'ACTIVE',
    razorpaySubscriptionId: 'sub_rzp', stripeSubscriptionId: 'sub_str',
    lastPaddleEventAt: null, pendingTierSlug: null,
  });
  mockPrisma.pricingTier.findUnique.mockImplementation(({ where }) => Promise.resolve(FREE_TIERS[where.slug] || null));
  // update echoes back its data so hydrateSubscription works.
  mockPrisma.subscription.update.mockImplementation(({ data }) => Promise.resolve({ ...data, pendingTierSlug: data.pendingTierSlug ?? null }));
});

function cancelEvent(gateway) {
  return { gateway, internalStatus: 'CANCELLED', gatewaySubscriptionId: gateway === 'RAZORPAY' ? 'sub_rzp' : 'sub_str', gatewayCustomerId: 'cust_1' };
}

describe('cancel → free downgrade is vertical-aware (B4)', () => {
  test('ECOMMERCE tenant cancelled (Razorpay) → ecom-free, not APPOINTMENT free', async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ vertical: 'ECOMMERCE' });
    await syncBusinessSubscriptionFromGatewayEvent({ businessId: 'biz1', normalized: cancelEvent('RAZORPAY') });
    expect(mockPrisma.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tierId: 'ecom-free-id', status: 'ACTIVE', razorpaySubscriptionId: null }),
    }));
  });

  test('STATIC tenant cancelled (Stripe) → static-free', async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ vertical: 'STATIC' });
    await syncBusinessSubscriptionFromGatewayEvent({ businessId: 'biz1', normalized: cancelEvent('STRIPE') });
    expect(mockPrisma.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tierId: 'static-free-id', stripeSubscriptionId: null }),
    }));
  });

  test('APPOINTMENT tenant cancelled → free (regression guard)', async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ vertical: 'APPOINTMENT' });
    await syncBusinessSubscriptionFromGatewayEvent({ businessId: 'biz1', normalized: cancelEvent('RAZORPAY') });
    expect(mockPrisma.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tierId: 'free-id' }),
    }));
  });

  test('unknown/missing vertical falls back to the generic free tier', async () => {
    mockPrisma.business.findUnique.mockResolvedValue(null);
    await syncBusinessSubscriptionFromGatewayEvent({ businessId: 'biz1', normalized: cancelEvent('RAZORPAY') });
    expect(mockPrisma.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tierId: 'free-id' }),
    }));
  });
});
