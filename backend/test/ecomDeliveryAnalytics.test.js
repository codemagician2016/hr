jest.mock('../src/core/lib/prisma', () => ({}));
jest.mock('../src/core/lib/webhookDispatcher', () => ({ safeEmit: jest.fn() }));
jest.mock('../src/core/lib/notifications/router', () => ({
  sendNotification: jest.fn(),
}));

const { buildDeliveryAnalytics } = require('../src/core/lib/ecomDeliveryAnalytics');

function delivery(overrides = {}) {
  return {
    id: overrides.id || 'del-1',
    businessId: 'biz-1',
    source: 'API',
    status: 'PENDING',
    priority: 'NORMAL',
    riderId: null,
    paymentMethod: 'online',
    cashToCollectMinor: 0,
    cashCollectedMinor: 0,
    createdAt: new Date('2026-06-10T08:00:00.000Z'),
    updatedAt: new Date('2026-06-10T08:00:00.000Z'),
    ...overrides,
  };
}

describe('ecomDeliveryAnalytics', () => {
  test('rolls up SLA, rider performance, COD, and exceptions', () => {
    const analytics = buildDeliveryAnalytics({
      now: new Date('2026-06-10T12:00:00.000Z'),
      since: new Date('2026-06-04T12:00:00.000Z'),
      days: 7,
      riders: [
        { id: 'rider-1', fullName: 'Asha Rider', phone: '+911', vehicleType: 'BIKE', status: 'ACTIVE' },
        { id: 'rider-2', fullName: 'Bilal Rider', phone: '+912', vehicleType: 'CYCLE', status: 'ACTIVE' },
      ],
      deliveries: [
        delivery({
          id: 'on-time',
          source: 'SITEPRESSO',
          status: 'DELIVERED',
          riderId: 'rider-1',
          promisedAt: new Date('2026-06-10T10:30:00.000Z'),
          pickedUpAt: new Date('2026-06-10T09:40:00.000Z'),
          deliveredAt: new Date('2026-06-10T10:20:00.000Z'),
          paymentMethod: 'cod',
          cashToCollectMinor: 1000,
          cashCollectedMinor: 1000,
          customerRating: 5,
        }),
        delivery({
          id: 'late',
          status: 'DELIVERED',
          riderId: 'rider-1',
          promisedAt: new Date('2026-06-10T10:00:00.000Z'),
          pickedUpAt: new Date('2026-06-10T09:30:00.000Z'),
          deliveredAt: new Date('2026-06-10T10:30:00.000Z'),
          customerRating: 3,
        }),
        delivery({
          id: 'failed',
          status: 'ATTEMPTED_FAILED',
          riderId: 'rider-2',
          failedAt: new Date('2026-06-10T11:00:00.000Z'),
          paymentMethod: 'cod',
          cashToCollectMinor: 500,
          exceptionCode: 'ADDRESS_ISSUE',
          exceptionStatus: 'OPEN',
        }),
        delivery({
          id: 'pending-cash',
          status: 'READY_FOR_DISPATCH',
          paymentMethod: 'cod',
          cashToCollectMinor: 300,
        }),
        delivery({
          id: 'cancelled',
          status: 'CANCELLED',
          paymentMethod: 'cod',
          cashToCollectMinor: 700,
        }),
      ],
    });

    expect(analytics.totals.total).toBe(5);
    expect(analytics.totals.delivered).toBe(2);
    expect(analytics.totals.active).toBe(2);
    expect(analytics.totals.unassigned).toBe(1);
    expect(analytics.totals.onTimePercent).toBe(50);
    expect(analytics.totals.avgDeliveryMinutes).toBe(50);
    expect(analytics.totals.ratedDeliveries).toBe(2);
    expect(analytics.totals.avgCustomerRating).toBe(4);
    expect(analytics.cash.toCollectMinor).toBe(2500);
    expect(analytics.cash.collectedMinor).toBe(1000);
    expect(analytics.cash.outstandingFromCustomersMinor).toBe(800);
    expect(analytics.exceptions.statuses.OPEN).toBe(1);
    expect(analytics.exceptions.breakdown.ADDRESS_ISSUE).toBe(1);
    expect(analytics.sourceCounts.SITEPRESSO).toBe(1);
    expect(analytics.statusCounts.ATTEMPTED_FAILED).toBe(1);

    const asha = analytics.riderPerformance.find((rider) => rider.id === 'rider-1');
    expect(asha.delivered).toBe(2);
    expect(asha.onTimePercent).toBe(50);
    expect(asha.avgDeliveryMinutes).toBe(50);
    expect(asha.cashCollectedMinor).toBe(1000);

    const bilal = analytics.riderPerformance.find((rider) => rider.id === 'rider-2');
    expect(bilal.active).toBe(1);
    expect(bilal.failed).toBe(1);
    expect(bilal.openExceptions).toBe(1);
    expect(bilal.cashOutstandingMinor).toBe(500);
  });

  test('daily buckets include the current calendar day', () => {
    const analytics = buildDeliveryAnalytics({
      now: new Date('2026-06-10T12:00:00.000Z'),
      days: 3,
      deliveries: [
        delivery({ id: 'today', createdAt: new Date('2026-06-10T01:00:00.000Z') }),
        delivery({ id: 'yesterday', createdAt: new Date('2026-06-09T01:00:00.000Z') }),
      ],
    });

    expect(analytics.daily.map((row) => row.date)).toEqual(['2026-06-08', '2026-06-09', '2026-06-10']);
    expect(analytics.daily[2].created).toBe(1);
  });
});
