const mockCreateDeliveryRequestFromOrder = jest.fn();
const mockRecordDeliveryEvent = jest.fn();

jest.mock('../src/core/lib/ecomDeliveryRequestService', () => ({
  createDeliveryRequestFromOrder: mockCreateDeliveryRequestFromOrder,
  deliveryStatusLabel: jest.fn((status) => String(status || '').replace(/_/g, ' ').toLowerCase()),
  deliveryTrackingPath: jest.fn(() => '/delivery/tok'),
  deliveryTrackingUrl: jest.fn(() => 'https://shop.example/delivery/tok'),
  deliveryWebhookPayload: jest.fn((delivery) => delivery),
  notifyDeliveryCustomer: jest.fn(),
  recordDeliveryEvent: mockRecordDeliveryEvent,
}));

const {
  syncDeliveryRequestForOrderDispatch,
  syncDeliveryRequestForOrderStatus,
} = require('../src/shop/controllers/order.controller');

function delivery(overrides = {}) {
  return {
    id: 'delivery-1',
    businessId: 'biz-1',
    orderId: 'order-1',
    source: 'SITEPRESSO',
    sourceRef: 'order-1',
    status: 'READY_FOR_DISPATCH',
    riderId: null,
    pickedUpAt: null,
    arrivedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    exceptionStatus: null,
    cashToCollectMinor: 0,
    cashCollectedMinor: 0,
    cashReceivedMinor: 0,
    cashChangeDueMinor: 0,
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    id: 'order-1',
    businessId: 'biz-1',
    fulfillmentType: 'DELIVERY',
    ...overrides,
  };
}

describe('syncDeliveryRequestForOrderDispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('advances an existing Sitepresso delivery request when an order is manually dispatched', async () => {
    const existing = delivery({
      status: 'ATTEMPTED_FAILED',
      exceptionStatus: 'OPEN',
      nextAttemptAt: new Date('2026-06-10T12:00:00.000Z'),
    });
    const tx = {
      ecomDeliveryRequest: {
        update: jest.fn(async ({ data }) => ({ ...existing, ...data })),
      },
      ecomDeliveryRouteStop: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockCreateDeliveryRequestFromOrder.mockResolvedValue({ created: false, delivery: existing });

    const result = await syncDeliveryRequestForOrderDispatch({
      prisma: tx,
      businessId: 'biz-1',
      order: order(),
      actorUserId: 'user-1',
    });

    expect(mockCreateDeliveryRequestFromOrder).toHaveBeenCalledWith(expect.objectContaining({
      prisma: tx,
      order: expect.objectContaining({ id: 'order-1' }),
      status: 'OUT_FOR_DELIVERY',
      actorUserId: 'user-1',
      emitEvents: false,
    }));
    expect(tx.ecomDeliveryRequest.update).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: expect.objectContaining({
        status: 'OUT_FOR_DELIVERY',
        nextAttemptAt: null,
        exceptionStatus: 'RESOLVED',
        exceptionResolvedAt: expect.any(Date),
        pickedUpAt: expect.any(Date),
      }),
    });
    expect(tx.ecomDeliveryRouteStop.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'order-1' },
      data: {
        deliveryRequestId: existing.id,
      },
    });
    expect(mockRecordDeliveryEvent).toHaveBeenCalledWith(expect.objectContaining({
      prisma: tx,
      businessId: 'biz-1',
      deliveryRequestId: existing.id,
      kind: 'STATUS_CHANGED',
      fromStatus: 'ATTEMPTED_FAILED',
      toStatus: 'OUT_FOR_DELIVERY',
      actorSource: 'ADMIN',
    }));
    expect(result).toMatchObject({
      created: false,
      previousStatus: 'ATTEMPTED_FAILED',
      delivery: { status: 'OUT_FOR_DELIVERY' },
    });
  });

  test('does not reopen terminal delivery requests', async () => {
    const existing = delivery({ status: 'DELIVERED' });
    const tx = {
      ecomDeliveryRequest: { update: jest.fn() },
    };
    mockCreateDeliveryRequestFromOrder.mockResolvedValue({ created: false, delivery: existing });

    const result = await syncDeliveryRequestForOrderDispatch({
      prisma: tx,
      businessId: 'biz-1',
      order: order(),
      actorUserId: 'user-1',
    });

    expect(tx.ecomDeliveryRequest.update).not.toHaveBeenCalled();
    expect(mockRecordDeliveryEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      created: false,
      previousStatus: 'DELIVERED',
      delivery: { status: 'DELIVERED' },
    });
  });

  test('marks the linked delivery request delivered when an order is delivered', async () => {
    const existing = delivery({
      status: 'OUT_FOR_DELIVERY',
      cashToCollectMinor: 1250,
      cashCollectedMinor: 0,
      exceptionStatus: 'OPEN',
    });
    const tx = {
      ecomDeliveryRequest: {
        findFirst: jest.fn().mockResolvedValue(existing),
        update: jest.fn(async ({ data }) => ({ ...existing, ...data })),
      },
      ecomDeliveryRouteStop: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const result = await syncDeliveryRequestForOrderStatus({
      prisma: tx,
      businessId: 'biz-1',
      order: order(),
      nextStatus: 'DELIVERED',
      actorUserId: 'user-1',
    });

    expect(mockCreateDeliveryRequestFromOrder).not.toHaveBeenCalled();
    expect(tx.ecomDeliveryRequest.findFirst).toHaveBeenCalledWith({
      where: { businessId: 'biz-1', orderId: 'order-1' },
      orderBy: { createdAt: 'desc' },
    });
    expect(tx.ecomDeliveryRequest.update).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: expect.objectContaining({
        status: 'DELIVERED',
        nextAttemptAt: null,
        deliveredAt: expect.any(Date),
        arrivedAt: expect.any(Date),
        pickedUpAt: expect.any(Date),
        cashReceivedMinor: 1250,
        cashCollectedMinor: 1250,
        cashChangeDueMinor: 0,
        exceptionStatus: 'RESOLVED',
        exceptionResolvedAt: expect.any(Date),
      }),
    });
    expect(tx.ecomDeliveryRouteStop.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'order-1' },
      data: expect.objectContaining({
        deliveryRequestId: existing.id,
        status: 'DELIVERED',
        deliveredAt: expect.any(Date),
        cashCollectedMinor: 1250,
        cashReceivedMinor: 1250,
        cashChangeDueMinor: 0,
      }),
    });
    expect(mockRecordDeliveryEvent).toHaveBeenCalledWith(expect.objectContaining({
      prisma: tx,
      businessId: 'biz-1',
      deliveryRequestId: existing.id,
      kind: 'STATUS_CHANGED',
      fromStatus: 'OUT_FOR_DELIVERY',
      toStatus: 'DELIVERED',
      actorSource: 'ADMIN',
      payload: expect.objectContaining({ cashCollectedMinor: 1250 }),
    }));
    expect(result).toMatchObject({
      created: false,
      previousStatus: 'OUT_FOR_DELIVERY',
      delivery: { status: 'DELIVERED', cashCollectedMinor: 1250 },
    });
  });

  test('cancels the linked delivery request when an order is cancelled', async () => {
    const existing = delivery({
      status: 'OUT_FOR_DELIVERY',
      exceptionStatus: 'OPEN',
    });
    const tx = {
      ecomDeliveryRequest: {
        findFirst: jest.fn().mockResolvedValue(existing),
        update: jest.fn(async ({ data }) => ({ ...existing, ...data })),
      },
      ecomDeliveryRouteStop: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const result = await syncDeliveryRequestForOrderStatus({
      prisma: tx,
      businessId: 'biz-1',
      order: order(),
      nextStatus: 'CANCELLED',
      reason: 'Customer requested cancellation',
      actorUserId: 'user-1',
    });

    expect(mockCreateDeliveryRequestFromOrder).not.toHaveBeenCalled();
    expect(tx.ecomDeliveryRequest.update).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: expect.objectContaining({
        status: 'CANCELLED',
        nextAttemptAt: null,
        cancelledAt: expect.any(Date),
        failureReason: 'Customer requested cancellation',
        exceptionStatus: 'RESOLVED',
        exceptionResolvedAt: expect.any(Date),
      }),
    });
    expect(tx.ecomDeliveryRouteStop.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'order-1' },
      data: expect.objectContaining({
        deliveryRequestId: existing.id,
        status: 'SKIPPED',
        notes: 'Customer requested cancellation',
      }),
    });
    expect(mockRecordDeliveryEvent).toHaveBeenCalledWith(expect.objectContaining({
      prisma: tx,
      businessId: 'biz-1',
      deliveryRequestId: existing.id,
      kind: 'STATUS_CHANGED',
      fromStatus: 'OUT_FOR_DELIVERY',
      toStatus: 'CANCELLED',
      actorSource: 'ADMIN',
      payload: expect.objectContaining({ reason: 'Customer requested cancellation' }),
    }));
    expect(result).toMatchObject({
      created: false,
      previousStatus: 'OUT_FOR_DELIVERY',
      delivery: { status: 'CANCELLED', failureReason: 'Customer requested cancellation' },
    });
  });

  test('ignores pickup orders', async () => {
    const result = await syncDeliveryRequestForOrderDispatch({
      prisma: { ecomDeliveryRequest: { update: jest.fn() } },
      businessId: 'biz-1',
      order: order({ fulfillmentType: 'PICKUP' }),
      actorUserId: 'user-1',
    });

    expect(result).toBe(null);
    expect(mockCreateDeliveryRequestFromOrder).not.toHaveBeenCalled();
  });
});
