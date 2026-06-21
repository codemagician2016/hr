// ECOMMERCE Path B Phase 3b — unit tests for the activity-event recorder.
// Pure function with mocked Prisma — no DB.

jest.mock('../src/core/lib/prisma', () => ({
  ecomActivityEvent: { create: jest.fn() },
}));

const prisma = require('../src/core/lib/prisma');
const { logActivity, VALID_AREAS, VALID_SEVERITIES } = require('../src/core/lib/ecomActivityLogger');

beforeEach(() => {
  prisma.ecomActivityEvent.create.mockReset();
});

describe('logActivity', () => {
  function fakeReq(overrides = {}) {
    return {
      user: { id: 'u1', businessId: 'b1', name: 'Alice', role: 'BUSINESS_ADMIN' },
      ip: '1.2.3.4',
      headers: { 'user-agent': 'jest' },
      ...overrides,
    };
  }

  test('creates an event with snapshotted actor + IP + UA', async () => {
    prisma.ecomActivityEvent.create.mockResolvedValue({ id: 'evt1' });
    const result = await logActivity(fakeReq(), {
      eventKey: 'inventory.adjusted',
      area: 'inventory',
      targetType: 'inventoryStock',
      targetId: 's1',
      payload: { delta: 5 },
    });
    expect(result).toEqual({ id: 'evt1' });
    expect(prisma.ecomActivityEvent.create).toHaveBeenCalledTimes(1);
    const data = prisma.ecomActivityEvent.create.mock.calls[0][0].data;
    expect(data.businessId).toBe('b1');
    expect(data.eventKey).toBe('inventory.adjusted');
    expect(data.area).toBe('inventory');
    expect(data.severity).toBe('INFO');
    expect(data.outcome).toBe('SUCCESS');
    expect(data.actorSource).toBe('ADMIN');
    expect(data.actorUserId).toBe('u1');
    expect(data.actorName).toBe('Alice');
    expect(data.actorRole).toBe('BUSINESS_ADMIN');
    expect(data.ipAddress).toBe('1.2.3.4');
    expect(data.userAgent).toBe('jest');
    expect(data.payload).toEqual({ delta: 5 });
  });

  test('skips when no businessId is in scope', async () => {
    const result = await logActivity({ user: null }, {
      eventKey: 'orders.created',
      area: 'orders',
    });
    expect(result).toBeNull();
    expect(prisma.ecomActivityEvent.create).not.toHaveBeenCalled();
  });

  test('skips and warns on invalid area', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await logActivity(fakeReq(), {
      eventKey: 'something.weird',
      area: 'bogus_area',
    });
    expect(result).toBeNull();
    expect(prisma.ecomActivityEvent.create).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('coerces invalid severity to INFO', async () => {
    prisma.ecomActivityEvent.create.mockResolvedValue({ id: 'evt2' });
    await logActivity(fakeReq(), {
      eventKey: 'orders.refunded',
      area: 'orders',
      severity: 'NOT_REAL',
    });
    const data = prisma.ecomActivityEvent.create.mock.calls[0][0].data;
    expect(data.severity).toBe('INFO');
  });

  test('coerces invalid outcome to SUCCESS', async () => {
    prisma.ecomActivityEvent.create.mockResolvedValue({ id: 'evt3' });
    await logActivity(fakeReq(), {
      eventKey: 'orders.refunded',
      area: 'orders',
      outcome: 'WHATEVER',
    });
    const data = prisma.ecomActivityEvent.create.mock.calls[0][0].data;
    expect(data.outcome).toBe('SUCCESS');
  });

  test('coerces invalid actorSource to ADMIN', async () => {
    prisma.ecomActivityEvent.create.mockResolvedValue({ id: 'evt4' });
    await logActivity(fakeReq(), {
      eventKey: 'orders.refunded',
      area: 'orders',
      actorSource: 'EVIL',
    });
    const data = prisma.ecomActivityEvent.create.mock.calls[0][0].data;
    expect(data.actorSource).toBe('ADMIN');
  });

  test('swallows DB errors and returns null', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    prisma.ecomActivityEvent.create.mockRejectedValue(new Error('boom'));
    const result = await logActivity(fakeReq(), {
      eventKey: 'inventory.adjusted',
      area: 'inventory',
    });
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('explicit businessId overrides req.user (cron caller)', async () => {
    prisma.ecomActivityEvent.create.mockResolvedValue({ id: 'evt5' });
    await logActivity({ user: null, ip: null, headers: {} }, {
      eventKey: 'cron.snapshot',
      area: 'system',
      businessId: 'override-biz',
      actorSource: 'CRON',
    });
    const data = prisma.ecomActivityEvent.create.mock.calls[0][0].data;
    expect(data.businessId).toBe('override-biz');
    expect(data.actorSource).toBe('CRON');
    expect(data.actorUserId).toBeNull();
  });

  test('valid area set is exposed for callers', () => {
    expect(VALID_AREAS.has('inventory')).toBe(true);
    expect(VALID_AREAS.has('finance')).toBe(true);
    expect(VALID_AREAS.has('auth')).toBe(true);
    expect(VALID_AREAS.has('marketing')).toBe(true);
    expect(VALID_AREAS.has('made_up')).toBe(false);
  });

  test('valid severities exposed', () => {
    expect(VALID_SEVERITIES.size).toBe(4);
    expect(VALID_SEVERITIES.has('SECURITY')).toBe(true);
  });
});
