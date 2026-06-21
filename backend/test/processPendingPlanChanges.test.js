// processPendingPlanChanges — applies scheduled (period-end) plan changes.
// B3 regression guard: must NOT re-activate a sub that lapsed (PAST_DUE/PAUSED/
// CANCELLED) before its effective date, which would re-grant paid access with no
// payment and override dunning.

jest.mock('../src/core/lib/prisma', () => ({
  subscription: { findMany: jest.fn(), update: jest.fn() },
  pricingTier: { findUnique: jest.fn() },
  // unrelated models touched at module load
  appointment: { findMany: jest.fn(), update: jest.fn() },
  emailDelivery: { findMany: jest.fn() },
  user: { findFirst: jest.fn(), findMany: jest.fn() },
}));

const prisma = require('../src/core/lib/prisma');
const { processPendingPlanChanges } = require('../src/core/lib/scheduler');

beforeEach(() => {
  jest.clearAllMocks();
  prisma.subscription.update.mockResolvedValue({});
  prisma.pricingTier.findUnique.mockResolvedValue({ id: 'tier-basic', slug: 'basic' });
});

function dueRow(over = {}) {
  return {
    id: 'sub-1', businessId: 'biz1', status: 'ACTIVE',
    pendingTierSlug: 'basic', pendingBillingCycle: 'MONTHLY',
    pendingChangeEffectiveAt: new Date('2026-06-01'), business: { name: 'Acme' }, ...over,
  };
}

describe('processPendingPlanChanges', () => {
  test('applies a due downgrade for an ACTIVE sub: tier+cycle flip, status ACTIVE, pending nulled', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([dueRow({ status: 'ACTIVE' })]);
    await processPendingPlanChanges();
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'sub-1' },
      data: expect.objectContaining({
        tierId: 'tier-basic', billingCycle: 'MONTHLY', status: 'ACTIVE',
        pendingTierSlug: null, pendingBillingCycle: null, pendingChangeEffectiveAt: null,
      }),
    });
  });

  test('B3: a PAST_DUE sub with a due pending change flips tier but is NOT re-activated', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([dueRow({ status: 'PAST_DUE' })]);
    await processPendingPlanChanges();
    const data = prisma.subscription.update.mock.calls[0][0].data;
    expect(data.tierId).toBe('tier-basic');         // tier change still applied
    expect(data).not.toHaveProperty('status');       // but status NOT forced to ACTIVE
  });

  test('B3: a CANCELLED sub is not re-activated either', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([dueRow({ status: 'CANCELLED' })]);
    await processPendingPlanChanges();
    expect(prisma.subscription.update.mock.calls[0][0].data).not.toHaveProperty('status');
  });

  test('a TRIALING sub IS allowed to stamp ACTIVE on its scheduled change', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([dueRow({ status: 'TRIALING' })]);
    await processPendingPlanChanges();
    expect(prisma.subscription.update.mock.calls[0][0].data.status).toBe('ACTIVE');
  });

  test('skips (no update) when the pending tier no longer exists', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([dueRow()]);
    prisma.pricingTier.findUnique.mockResolvedValueOnce(null);
    await processPendingPlanChanges();
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  test('no due rows → no work', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([]);
    await processPendingPlanChanges();
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });
});
