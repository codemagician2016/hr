// Locks in the businessId filter on the operator inbox query — the
// defence-in-depth half of the 2026-05-12 vertical-isolation fix.
//
// Even if the auth middleware were to misidentify the request (e.g.
// stale cookie + a routing edge case), an operator must NEVER receive
// notifications attached to a business other than their own.

jest.mock('../src/core/lib/prisma', () => ({
  inboxNotification: {
    findMany: jest.fn(async () => []),
    count: jest.fn(async () => 0),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(async () => ({ count: 0 })),
    create: jest.fn(),
  },
  user: { findMany: jest.fn() },
  customer: { update: jest.fn() },
  $transaction: jest.fn(async (ops) => Promise.all(ops)),
}));

const prisma = require('../src/core/lib/prisma');
const {
  listInboxNotificationsForRequest,
  markAllInboxNotificationsReadForRequest,
  markInboxNotificationReadForRequest,
} = require('../src/core/lib/inbox');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('operator inbox is scoped to req.user.businessId', () => {
  test('list filters by both userId AND businessId', async () => {
    const req = { authType: 'user', user: { id: 'op-1', businessId: 'biz-A' } };
    await listInboxNotificationsForRequest(req);

    const where = prisma.inboxNotification.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe('op-1');
    expect(where.businessId).toBe('biz-A');
  });

  test('unread count uses the same scoped filter', async () => {
    const req = { authType: 'user', user: { id: 'op-1', businessId: 'biz-A' } };
    await listInboxNotificationsForRequest(req);

    const countWhere = prisma.inboxNotification.count.mock.calls[0][0].where;
    expect(countWhere.userId).toBe('op-1');
    expect(countWhere.businessId).toBe('biz-A');
    expect(countWhere.readAt).toBeNull();
  });

  test('customer inbox is NOT business-scoped (customer accounts span businesses)', async () => {
    const req = { authType: 'customer', customer: { id: 'cust-9' } };
    await listInboxNotificationsForRequest(req);

    const where = prisma.inboxNotification.findMany.mock.calls[0][0].where;
    expect(where.customerId).toBe('cust-9');
    expect(where.businessId).toBeUndefined();
    expect(where.userId).toBeUndefined();
  });

  test('mark-all-read for operator is business-scoped', async () => {
    const req = { authType: 'user', user: { id: 'op-1', businessId: 'biz-A' } };
    await markAllInboxNotificationsReadForRequest(req);

    const where = prisma.inboxNotification.updateMany.mock.calls[0][0].where;
    expect(where.userId).toBe('op-1');
    expect(where.businessId).toBe('biz-A');
    expect(where.readAt).toBeNull();
  });

  test('mark-one-read refuses a notification belonging to another business', async () => {
    prisma.inboxNotification.findUnique.mockResolvedValueOnce({
      id: 'notif-1',
      userId: 'op-1',
      customerId: null,
      readAt: null,
    });
    // Defence-in-depth check returns nothing → not in this business.
    prisma.inboxNotification.findFirst.mockResolvedValueOnce(null);

    const req = { authType: 'user', user: { id: 'op-1', businessId: 'biz-A' } };
    const result = await markInboxNotificationReadForRequest(req, 'notif-1');
    expect(result).toBeNull();
    expect(prisma.inboxNotification.update).not.toHaveBeenCalled();
  });

  test('mark-one-read succeeds when the notification IS in the operator business', async () => {
    prisma.inboxNotification.findUnique.mockResolvedValueOnce({
      id: 'notif-1',
      userId: 'op-1',
      customerId: null,
      readAt: null,
    });
    prisma.inboxNotification.findFirst.mockResolvedValueOnce({ id: 'notif-1' });
    prisma.inboxNotification.update.mockResolvedValueOnce({ id: 'notif-1', readAt: new Date() });

    const req = { authType: 'user', user: { id: 'op-1', businessId: 'biz-A' } };
    const result = await markInboxNotificationReadForRequest(req, 'notif-1');
    expect(result).not.toBeNull();
    expect(prisma.inboxNotification.findFirst).toHaveBeenCalledWith({
      where: { id: 'notif-1', businessId: 'biz-A' },
      select: { id: true },
    });
  });
});

// Regression for the live-staging 502 root cause: an operator with NO business
// in scope (businessId === null — e.g. a SUPER_ADMIN) must never pass
// `businessId: null` to Prisma. The non-nullable field rejects null with a
// PrismaClientValidationError which, thrown from a raw async handler, crashed the
// whole backend and 502'd every other request (including payment onboarding).
describe('operator with no business in scope (businessId null)', () => {
  test('list omits businessId from the filter instead of passing null', async () => {
    const req = { authType: 'user', user: { id: 'op-x', businessId: null } };
    await listInboxNotificationsForRequest(req);

    const where = prisma.inboxNotification.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe('op-x');
    expect('businessId' in where).toBe(false);
  });

  test('mark-all-read omits businessId when null', async () => {
    const req = { authType: 'user', user: { id: 'op-x', businessId: null } };
    await markAllInboxNotificationsReadForRequest(req);

    const where = prisma.inboxNotification.updateMany.mock.calls[0][0].where;
    expect(where.userId).toBe('op-x');
    expect('businessId' in where).toBe(false);
    expect(where.readAt).toBeNull();
  });

  test('mark-one-read skips the business-scope query when businessId is null', async () => {
    prisma.inboxNotification.findUnique.mockResolvedValueOnce({
      id: 'n1', userId: 'op-x', customerId: null, readAt: null,
    });
    prisma.inboxNotification.update.mockResolvedValueOnce({ id: 'n1', readAt: new Date() });

    const req = { authType: 'user', user: { id: 'op-x', businessId: null } };
    const result = await markInboxNotificationReadForRequest(req, 'n1');
    expect(result).not.toBeNull();
    expect(prisma.inboxNotification.findFirst).not.toHaveBeenCalled();
  });
});
