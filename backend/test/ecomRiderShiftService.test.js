jest.mock('../src/core/lib/prisma', () => ({}));

const {
  assertRiderOnShift,
  calculateRiderShiftCashSummary,
  endRiderShift,
  startRiderShift,
} = require('../src/core/lib/ecomRiderShiftService');

function shift(overrides = {}) {
  return {
    id: 'shift-1',
    businessId: 'biz-1',
    riderId: 'rider-1',
    locationId: 'loc-1',
    location: { id: 'loc-1', name: 'Main', city: 'Delhi' },
    status: 'OPEN',
    startedAt: new Date('2026-06-10T08:00:00.000Z'),
    endedAt: null,
    cashFloatMinor: 1000,
    cashInHandMinor: 0,
    createdAt: new Date('2026-06-10T08:00:00.000Z'),
    updatedAt: new Date('2026-06-10T08:00:00.000Z'),
    ...overrides,
  };
}

describe('ecomRiderShiftService', () => {
  test('startRiderShift creates an open shift and marks rider active', async () => {
    const tx = {
      ecomRiderShift: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(shift({ ...data, location: { id: 'loc-1', name: 'Main', city: 'Delhi' } }))),
      },
      ecomRider: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      ecomRider: {
        findFirst: jest.fn().mockResolvedValue({ id: 'rider-1', status: 'OFF_SHIFT', homeLocationId: 'loc-1' }),
      },
      businessLocation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'loc-1' }),
      },
      ecomRiderShift: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(async (fn) => fn(tx)),
    };

    const result = await startRiderShift({
      prisma,
      businessId: 'biz-1',
      riderId: 'rider-1',
      actorUserId: 'user-1',
      input: { cashFloatMinor: 1250, lat: 28.6, lng: 77.2 },
    });

    expect(result.created).toBe(true);
    expect(result.shift.cashFloatMinor).toBe(1250);
    expect(tx.ecomRider.update).toHaveBeenCalledWith({
      where: { id: 'rider-1' },
      data: { status: 'ACTIVE', cashFloatMinor: 1250 },
    });
  });

  test('startRiderShift returns existing open shift idempotently', async () => {
    const existing = shift();
    const prisma = {
      ecomRider: {
        findFirst: jest.fn().mockResolvedValue({ id: 'rider-1', status: 'ACTIVE', homeLocationId: 'loc-1' }),
      },
      ecomRiderShift: {
        findFirst: jest.fn().mockResolvedValue(existing),
      },
    };

    const result = await startRiderShift({ prisma, businessId: 'biz-1', riderId: 'rider-1' });

    expect(result).toMatchObject({ created: false, shift: { id: existing.id, status: 'OPEN' } });
  });

  test('startRiderShift rejects unavailable rider statuses', async () => {
    const prisma = {
      ecomRider: {
        findFirst: jest.fn().mockResolvedValue({ id: 'rider-1', status: 'SUSPENDED', homeLocationId: 'loc-1' }),
      },
    };

    await expect(startRiderShift({ prisma, businessId: 'biz-1', riderId: 'rider-1' }))
      .rejects.toMatchObject({ reason: 'RIDER_NOT_AVAILABLE', status: 409 });
  });

  test('endRiderShift closes active shift and marks rider off shift', async () => {
    const active = shift();
    const tx = {
      ecomRiderShift: {
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve(shift({ ...active, ...data }))),
      },
      ecomRider: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      ecomRiderShift: {
        findFirst: jest.fn().mockResolvedValue(active),
      },
      $transaction: jest.fn(async (fn) => fn(tx)),
    };

    const result = await endRiderShift({
      prisma,
      businessId: 'biz-1',
      riderId: 'rider-1',
      actorUserId: 'user-1',
      input: { cashInHandMinor: 2400 },
    });

    expect(result.status).toBe('CLOSED');
    expect(result.cashInHandMinor).toBe(2400);
    expect(tx.ecomRider.update).toHaveBeenCalledWith({
      where: { id: 'rider-1' },
      data: { status: 'OFF_SHIFT' },
    });
  });

  test('assertRiderOnShift rejects when no shift is open', async () => {
    const prisma = {
      ecomRiderShift: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    await expect(assertRiderOnShift({ prisma, businessId: 'biz-1', riderId: 'rider-1' }))
      .rejects.toMatchObject({ reason: 'SHIFT_REQUIRED', status: 409 });
  });

  test('calculateRiderShiftCashSummary sums active-shift direct and route COD handover cash', async () => {
    const prisma = {
      ecomDeliveryRequest: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'direct-1', cashCollectedMinor: 2500, cashReceivedMinor: 3000, cashChangeDueMinor: 500 },
          { id: 'direct-legacy', cashCollectedMinor: 1200, cashReceivedMinor: 0, cashChangeDueMinor: 0 },
        ]),
      },
      ecomDeliveryRouteStop: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'stop-1', cashCollectedMinor: 800, cashReceivedMinor: 1000, cashChangeDueMinor: 200 },
        ]),
      },
    };

    const summary = await calculateRiderShiftCashSummary({
      prisma,
      businessId: 'biz-1',
      riderId: 'rider-1',
      startedAt: new Date('2026-06-10T08:00:00.000Z'),
      endedAt: new Date('2026-06-10T18:00:00.000Z'),
    });

    expect(summary).toMatchObject({
      expectedCashInHandMinor: 4500,
      cashCollectedMinor: 4500,
      cashReceivedMinor: 4000,
      cashChangeDueMinor: 700,
      directDeliveryCount: 2,
      routeStopCount: 1,
      deliveryCount: 3,
    });
    expect(prisma.ecomDeliveryRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        businessId: 'biz-1',
        riderId: 'rider-1',
        status: 'DELIVERED',
        routeStops: { none: {} },
      }),
    }));
    expect(prisma.ecomDeliveryRouteStop.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'DELIVERED',
        route: { is: { businessId: 'biz-1', riderId: 'rider-1' } },
      }),
    }));
  });
});
