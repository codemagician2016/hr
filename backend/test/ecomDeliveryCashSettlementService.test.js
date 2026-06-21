jest.mock('../src/core/lib/prisma', () => ({}));

const {
  buildPendingLedger,
  createCashSettlement,
} = require('../src/core/lib/ecomDeliveryCashSettlementService');

function cashDelivery(overrides = {}) {
  return {
    id: overrides.id || 'delivery-1',
    businessId: 'biz-1',
    locationId: 'loc-1',
    riderId: 'rider-1',
    rider: { id: 'rider-1', fullName: 'Asha Rider', phone: '+911', vehicleType: 'BIKE', status: 'ACTIVE' },
    status: 'DELIVERED',
    currency: 'INR',
    cashToCollectMinor: 1000,
    cashCollectedMinor: 1000,
    deliveredAt: new Date('2026-06-10T10:00:00.000Z'),
    createdAt: new Date('2026-06-10T09:00:00.000Z'),
    updatedAt: new Date('2026-06-10T10:00:00.000Z'),
    ...overrides,
  };
}

describe('ecomDeliveryCashSettlementService', () => {
  test('buildPendingLedger groups unsettled cash by rider and excludes settled deliveries', () => {
    const pending = buildPendingLedger({
      deliveries: [
        cashDelivery({ id: 'delivery-1', cashCollectedMinor: 1000 }),
        cashDelivery({ id: 'delivery-2', cashCollectedMinor: 1200 }),
        cashDelivery({
          id: 'delivery-3',
          riderId: 'rider-2',
          rider: { id: 'rider-2', fullName: 'Bilal Rider', vehicleType: 'CYCLE', status: 'ACTIVE' },
          cashCollectedMinor: 700,
        }),
      ],
      settlements: [{ status: 'SETTLED', deliveryIds: ['delivery-2'] }],
    });

    expect(pending).toHaveLength(2);
    const asha = pending.find((group) => group.riderId === 'rider-1');
    expect(asha.deliveryCount).toBe(1);
    expect(asha.expectedCashMinor).toBe(1000);
    expect(asha.deliveryIds).toEqual(['delivery-1']);
    expect(asha.deliveries).toEqual([
      expect.objectContaining({
        id: 'delivery-1',
        cashCollectedMinor: 1000,
        deliveredAt: '2026-06-10T10:00:00.000Z',
      }),
    ]);
    const bilal = pending.find((group) => group.riderId === 'rider-2');
    expect(bilal.expectedCashMinor).toBe(700);
  });

  test('createCashSettlement records only unsettled selected deliveries', async () => {
    const prisma = {
      ecomRider: {
        findFirst: jest.fn().mockResolvedValue({ id: 'rider-1', fullName: 'Asha Rider' }),
      },
      ecomDeliveryRequest: {
        findMany: jest.fn().mockResolvedValue([
          cashDelivery({ id: 'delivery-1', cashCollectedMinor: 1000 }),
          cashDelivery({ id: 'delivery-2', cashCollectedMinor: 1200 }),
        ]),
      },
      ecomDeliveryCashSettlement: {
        findMany: jest.fn().mockResolvedValue([{ status: 'SETTLED', deliveryIds: ['delivery-2'] }]),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({
          id: 'settlement-1',
          ...data,
          rider: { id: 'rider-1', fullName: 'Asha Rider', phone: '+911', vehicleType: 'BIKE', status: 'ACTIVE' },
          location: { id: 'loc-1', name: 'Main', city: 'Delhi' },
          createdAt: new Date('2026-06-10T12:00:00.000Z'),
          updatedAt: new Date('2026-06-10T12:00:00.000Z'),
        })),
      },
    };

    const settlement = await createCashSettlement({
      prisma,
      businessId: 'biz-1',
      actorUserId: 'user-1',
      input: {
        riderId: 'rider-1',
        locationId: 'loc-1',
        countedCashMinor: 900,
        deliveryIds: ['delivery-1', 'delivery-2'],
      },
    });

    expect(settlement.expectedCashMinor).toBe(1000);
    expect(settlement.countedCashMinor).toBe(900);
    expect(settlement.varianceMinor).toBe(-100);
    expect(settlement.deliveryIds).toEqual(['delivery-1']);
    expect(prisma.ecomDeliveryCashSettlement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        businessId: 'biz-1',
        riderId: 'rider-1',
        deliveryCount: 1,
        settledByUserId: 'user-1',
      }),
    }));
  });
});
