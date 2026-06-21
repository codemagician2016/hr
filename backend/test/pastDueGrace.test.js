// expirePastDueGraceSubscriptions — the dunning grace-expiry cron. After a
// PAST_DUE sub's grace window lapses it is downgraded to the VERTICAL-correct
// free tier with status EXPIRED. Previously untested (Phase 4).

jest.mock('../src/core/lib/prisma', () => ({
  subscription: { findMany: jest.fn(), update: jest.fn() },
  appointment: { findMany: jest.fn(), update: jest.fn() },
  emailDelivery: { findMany: jest.fn() },
  user: { findFirst: jest.fn(), findMany: jest.fn() },
}));

const FREE = { APPOINTMENT: { id: 'free-id' }, STATIC: { id: 'static-free-id' }, ECOMMERCE: { id: 'ecom-free-id' } };
jest.mock('../src/core/lib/subscriptionBilling', () => ({
  FREE_TIER_SLUGS: new Set(['free', 'static-free', 'ecom-free', 'trial']),
  getFreeTierForVertical: jest.fn(async (v) => FREE[String(v || '').toUpperCase()] || FREE.APPOINTMENT),
}));

const prisma = require('../src/core/lib/prisma');
const { expirePastDueGraceSubscriptions } = require('../src/core/lib/scheduler');

beforeEach(() => {
  jest.clearAllMocks();
  prisma.subscription.update.mockResolvedValue({});
});

describe('expirePastDueGraceSubscriptions', () => {
  test('ECOMMERCE PAST_DUE past grace → ecom-free, status EXPIRED, grace cleared', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([
      { businessId: 'biz1', tier: { slug: 'ecom-business' }, business: { vertical: 'ECOMMERCE' } },
    ]);
    await expirePastDueGraceSubscriptions();
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { businessId: 'biz1' },
      data: { tierId: 'ecom-free-id', status: 'EXPIRED', accessGraceUntil: null },
    });
  });

  test('only selects PAST_DUE subs whose grace has lapsed', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([]);
    await expirePastDueGraceSubscriptions();
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'PAST_DUE', accessGraceUntil: { lte: expect.any(Date) } }),
    }));
  });

  test('a sub already on a free tier is skipped (no update)', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([
      { businessId: 'biz1', tier: { slug: 'ecom-free' }, business: { vertical: 'ECOMMERCE' } },
    ]);
    await expirePastDueGraceSubscriptions();
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  test('mixed verticals each downgrade to their OWN free tier', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([
      { businessId: 'b-ecom', tier: { slug: 'ecom-business' }, business: { vertical: 'ECOMMERCE' } },
      { businessId: 'b-static', tier: { slug: 'static-business' }, business: { vertical: 'STATIC' } },
      { businessId: 'b-appt', tier: { slug: 'professional' }, business: { vertical: 'APPOINTMENT' } },
    ]);
    await expirePastDueGraceSubscriptions();
    const byBiz = Object.fromEntries(prisma.subscription.update.mock.calls.map((c) => [c[0].where.businessId, c[0].data.tierId]));
    expect(byBiz).toEqual({ 'b-ecom': 'ecom-free-id', 'b-static': 'static-free-id', 'b-appt': 'free-id' });
  });

  test('no expired subs → no updates', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([]);
    await expirePastDueGraceSubscriptions();
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });
});
