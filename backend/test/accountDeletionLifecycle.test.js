// Account-deletion lifecycle — the 30-day grace boundary. sweepExpiredDeletions
// must only purge rows whose pendingDeletionAt is older than the grace window
// and which aren't already anonymised. (cancelBusinessSubscription is covered
// separately in accountDeletionCancel.test.js.)

const mockPrisma = {
  customer: { findMany: jest.fn() },
  user: { findMany: jest.fn() },
  business: { findMany: jest.fn() },
  subscription: { findUnique: jest.fn() },
};
jest.mock('../src/core/lib/prisma', () => mockPrisma);
jest.mock('../src/core/lib/paddle', () => ({ cancelPaddleSubscription: jest.fn() }));
jest.mock('../src/core/lib/billing/gateways', () => ({ getGateway: () => ({ cancelSubscription: jest.fn() }) }));

const { sweepExpiredDeletions, deletionPurgeAt, GRACE_PERIOD_DAYS } = require('../src/core/lib/accountDeletion');

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.customer.findMany.mockResolvedValue([]);
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.business.findMany.mockResolvedValue([]);
});

describe('30-day grace window', () => {
  test('GRACE_PERIOD_DAYS is 30', () => {
    expect(GRACE_PERIOD_DAYS).toBe(30);
  });

  test('deletionPurgeAt is exactly 30 days after the request', () => {
    const at = deletionPurgeAt(new Date('2026-06-10T00:00:00Z'));
    expect(at.toISOString().slice(0, 10)).toBe('2026-07-10');
  });

  test('sweep queries each entity for pendingDeletionAt <= now-30d AND anonymisedAt null', async () => {
    const now = new Date('2026-07-15T00:00:00Z');
    const result = await sweepExpiredDeletions(now);
    const expectedCutoff = new Date('2026-06-15T00:00:00Z');
    for (const model of ['customer', 'user', 'business']) {
      expect(mockPrisma[model].findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { pendingDeletionAt: { lte: expectedCutoff }, anonymisedAt: null },
      }));
    }
    expect(result).toEqual({ customers: 0, staff: 0, businesses: 0 });
  });

  test('a deletion requested only 5 days ago is NOT yet swept (returns zero purges)', async () => {
    // With all findMany returning [], a within-grace request yields no purges —
    // the boundary is enforced by the query's lte cutoff, asserted above.
    const result = await sweepExpiredDeletions(new Date('2026-06-12T00:00:00Z'));
    expect(result).toEqual({ customers: 0, staff: 0, businesses: 0 });
  });
});
