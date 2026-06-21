const mockPrisma = {
  businessLocation: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  business: {
    findUnique: jest.fn(),
  },
  ecomDeliveryZone: {
    findMany: jest.fn(),
    count: jest.fn(),
  },
  ecomServiceCity: {
    findMany: jest.fn(),
  },
  ecomRider: {
    findFirst: jest.fn(),
  },
  ecomDeliveryRequest: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  ecomDeliveryRequestEvent: {
    create: jest.fn(),
  },
  order: {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  },
  ecomOrderEvent: {
    create: jest.fn(),
  },
  ecomDeliveryRouteStop: {
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(async (fn) => fn(mockPrisma)),
};

jest.mock('../src/core/lib/prisma', () => mockPrisma);
jest.mock('../src/core/lib/webhookDispatcher', () => ({ safeEmit: jest.fn() }));
jest.mock('../src/core/lib/notifications/router', () => ({
  sendNotification: jest.fn().mockResolvedValue({ ok: true }),
}));

const { sendNotification } = require('../src/core/lib/notifications/router');
const { safeEmit } = require('../src/core/lib/webhookDispatcher');

const {
  DELIVERY_STATUS_TRANSITIONS,
  allowedDeliveryStatusTransitions,
  canTransitionDeliveryStatus,
  computeDeliveryDispatchMeta,
  createDeliveryRequest,
  createDeliveryRequestFromOrder,
  deliveryTrackingPath,
  deliveryTrackingUrl,
  submitDeliveryCustomerFeedback,
  updateDeliveryException,
  updateDeliveryRequestStatus,
} = require('../src/core/lib/ecomDeliveryRequestService');

describe('ecomDeliveryRequestService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.businessLocation.findFirst.mockResolvedValue({ id: 'loc-1' });
    mockPrisma.businessLocation.findMany.mockResolvedValue([]);
    mockPrisma.business.findUnique.mockResolvedValue({ name: 'Shop', slug: 'shop', address: '1 Store St', country: 'IN' });
    mockPrisma.ecomDeliveryZone.findMany.mockResolvedValue([]);
    mockPrisma.ecomDeliveryZone.count.mockResolvedValue(0);
    mockPrisma.ecomServiceCity.findMany.mockResolvedValue([]);
    mockPrisma.ecomRider.findFirst.mockResolvedValue({ id: 'rider-1', fullName: 'Rider One', status: 'ACTIVE' });
    mockPrisma.ecomDeliveryRequest.findFirst.mockResolvedValue(null);
    mockPrisma.ecomDeliveryRequest.create.mockImplementation(({ data }) => Promise.resolve({
      id: 'del-1',
      ...data,
      createdAt: new Date('2026-06-10T00:00:00.000Z'),
      updatedAt: new Date('2026-06-10T00:00:00.000Z'),
    }));
    mockPrisma.ecomDeliveryRequest.update.mockImplementation(({ data }) => Promise.resolve({
      id: 'del-1',
      businessId: 'biz-1',
      source: 'API',
      sourceRef: 'ext-1',
      customerName: 'Customer',
      customerPhone: '+919000000000',
      customerEmail: 'customer@example.com',
      dropoffCountry: 'IN',
      currency: 'INR',
      cashToCollectMinor: 0,
      trackingToken: 'tok',
      createdAt: new Date('2026-06-10T00:00:00.000Z'),
      updatedAt: new Date('2026-06-10T00:00:00.000Z'),
      ...data,
    }));
    mockPrisma.ecomDeliveryRequestEvent.create.mockImplementation(({ data }) => Promise.resolve({
      id: `evt-${data.kind}`,
      ...data,
      createdAt: new Date('2026-06-10T00:00:00.000Z'),
    }));
  });

  test('returns existing API delivery when sourceRef already exists', async () => {
    mockPrisma.ecomDeliveryRequest.findFirst.mockResolvedValueOnce({
      id: 'existing',
      businessId: 'biz-1',
      source: 'API',
      sourceRef: 'ext-1',
    });

    const result = await createDeliveryRequest({
      businessId: 'biz-1',
      input: {
        source: 'API',
        sourceRef: 'ext-1',
        customerName: 'Customer',
        dropoff: { line1: '10 Road' },
      },
    });

    expect(result.created).toBe(false);
    expect(result.delivery.id).toBe('existing');
    expect(mockPrisma.ecomDeliveryRequest.create).not.toHaveBeenCalled();
    expect(mockPrisma.ecomDeliveryRequestEvent.create).not.toHaveBeenCalled();
  });

  test('resolves branch and promise time from delivery area when no location is supplied', async () => {
    mockPrisma.ecomDeliveryZone.findMany.mockResolvedValueOnce([{
      id: 'zone-1',
      name: 'Central',
      slug: 'central',
      cityId: 'city-1',
      primaryLocationId: 'loc-zone',
      postcodes: ['110001'],
      polygon: null,
      sortOrder: 1,
      deliveryFeeMinor: 500,
      freeDeliveryThresholdMinor: 0,
      expressSurchargeMinor: 0,
      promiseMinutes: 35,
    }]);
    mockPrisma.businessLocation.findMany.mockResolvedValueOnce([{
      id: 'loc-zone',
      name: 'Central Store',
      city: 'Delhi',
      isPrimary: true,
    }]);
    mockPrisma.businessLocation.findFirst.mockResolvedValue({ id: 'loc-zone', name: 'Central Store' });

    await createDeliveryRequest({
      businessId: 'biz-1',
      input: {
        source: 'API',
        customerName: 'Customer',
        dropoff: { line1: '10 Road', city: 'Delhi', postalCode: '110001' },
      },
    });

    expect(mockPrisma.ecomDeliveryRequest.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        locationId: 'loc-zone',
        promisedAt: expect.any(Date),
      }),
    }));
    expect(mockPrisma.ecomDeliveryRequestEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kind: 'CREATED',
        payload: expect.objectContaining({
          serviceArea: expect.objectContaining({
            zoneId: 'zone-1',
            locationId: 'loc-zone',
            promiseMinutes: 35,
          }),
        }),
      }),
    }));
  });

  test('rejects out-of-area API delivery when active delivery zones are configured', async () => {
    mockPrisma.ecomDeliveryZone.findMany.mockResolvedValueOnce([]);
    mockPrisma.ecomDeliveryZone.count.mockResolvedValueOnce(1);

    await expect(createDeliveryRequest({
      businessId: 'biz-1',
      input: {
        source: 'API',
        customerName: 'Customer',
        dropoff: { line1: '10 Road', city: 'Delhi', postalCode: '999999' },
      },
    })).rejects.toMatchObject({ reason: 'SERVICE_AREA_UNAVAILABLE', status: 422 });

    expect(mockPrisma.ecomDeliveryRequest.create).not.toHaveBeenCalled();
  });

  test('maps a Sitepresso COD order into a ready delivery request', async () => {
    const order = {
      id: 'order-1',
      businessId: 'biz-1',
      locationId: 'loc-1',
      fulfillmentType: 'DELIVERY',
      customerName: 'Asha',
      customerPhone: '+910000000000',
      customerEmail: 'asha@example.com',
      shippingAddress: { line1: '22 Market Rd', city: 'Delhi', postalCode: '110001', country: 'IN' },
      items: [{ id: 'item-1', productId: 'prod-1', productName: 'Pizza', quantity: 2, priceMinor: 30000, lineTotalMinor: 60000 }],
      notes: 'Ring bell',
      deliverySlotLabel: 'Today, 7 PM',
      promisedAt: new Date('2026-06-10T07:00:00.000Z'),
      currency: 'INR',
      paymentMethod: 'cod',
      paidAt: null,
      totalMinor: 60000,
      adjustedTotalMinor: null,
    };

    await createDeliveryRequestFromOrder({ order, status: 'READY_FOR_DISPATCH', emitEvents: false });

    expect(mockPrisma.ecomDeliveryRequest.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        businessId: 'biz-1',
        source: 'SITEPRESSO',
        sourceRef: 'order-1',
        orderId: 'order-1',
        status: 'READY_FOR_DISPATCH',
        customerName: 'Asha',
        dropoffAddress1: '22 Market Rd',
        cashToCollectMinor: 60000,
        proofOtp: expect.stringMatching(/^\d{4}$/),
        items: [expect.objectContaining({ name: 'Pizza', quantity: 2 })],
      }),
    }));
    expect(mockPrisma.ecomDeliveryRequestEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        businessId: 'biz-1',
        deliveryRequestId: 'del-1',
        kind: 'CREATED',
        toStatus: 'READY_FOR_DISPATCH',
        actorSource: 'SYSTEM',
      }),
    }));
    expect(mockPrisma.ecomDeliveryRequestEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        deliveryRequestId: 'del-1',
        kind: 'STATUS_CHANGED',
        fromStatus: 'PENDING',
        toStatus: 'READY_FOR_DISPATCH',
      }),
    }));
  });

  test('exposes the enforced delivery lifecycle transitions', () => {
    expect(DELIVERY_STATUS_TRANSITIONS.PENDING).toEqual(['READY_FOR_DISPATCH', 'ASSIGNED', 'CANCELLED']);
    expect(allowedDeliveryStatusTransitions('ATTEMPTED_FAILED')).toEqual(['READY_FOR_DISPATCH', 'ASSIGNED', 'CANCELLED', 'RETURNED']);
    expect(canTransitionDeliveryStatus('OUT_FOR_DELIVERY', 'DELIVERED')).toBe(true);
    expect(canTransitionDeliveryStatus('ATTEMPTED_FAILED', 'READY_FOR_DISPATCH')).toBe(true);
    expect(canTransitionDeliveryStatus('DELIVERED', 'OUT_FOR_DELIVERY')).toBe(false);
    expect(() => DELIVERY_STATUS_TRANSITIONS.PENDING.push('DELIVERED')).toThrow();
  });

  test('rejects invalid delivery lifecycle skips before writing', async () => {
    mockPrisma.ecomDeliveryRequest.findFirst.mockResolvedValueOnce({
      id: 'del-1',
      businessId: 'biz-1',
      source: 'API',
      sourceRef: 'ext-1',
      status: 'PENDING',
      paymentMethod: 'online',
      cashToCollectMinor: 0,
      cashCollectedMinor: 0,
      cashReceivedMinor: 0,
      cashChangeDueMinor: 0,
      customerName: 'Customer',
      currency: 'INR',
      trackingToken: 'tok',
    });

    await expect(updateDeliveryRequestStatus({
      businessId: 'biz-1',
      id: 'del-1',
      status: 'DELIVERED',
    })).rejects.toMatchObject({
      status: 409,
      reason: 'INVALID_STATUS_TRANSITION',
      allowedTransitions: ['READY_FOR_DISPATCH', 'ASSIGNED', 'CANCELLED'],
    });

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.ecomDeliveryRequest.update).not.toHaveBeenCalled();
  });

  test('does not reopen terminal delivered requests', async () => {
    mockPrisma.ecomDeliveryRequest.findFirst.mockResolvedValueOnce({
      id: 'del-1',
      businessId: 'biz-1',
      source: 'API',
      sourceRef: 'ext-1',
      status: 'DELIVERED',
      paymentMethod: 'online',
      cashToCollectMinor: 0,
      cashCollectedMinor: 0,
      cashReceivedMinor: 0,
      cashChangeDueMinor: 0,
      customerName: 'Customer',
      currency: 'INR',
      trackingToken: 'tok',
      deliveredAt: new Date('2026-06-10T10:00:00.000Z'),
    });

    await expect(updateDeliveryRequestStatus({
      businessId: 'biz-1',
      id: 'del-1',
      status: 'OUT_FOR_DELIVERY',
    })).rejects.toMatchObject({
      status: 409,
      reason: 'INVALID_STATUS_TRANSITION',
      allowedTransitions: [],
    });

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.ecomDeliveryRequest.update).not.toHaveBeenCalled();
  });

  test('rejects delivered COD status when collected cash is short', async () => {
    mockPrisma.ecomDeliveryRequest.findFirst.mockResolvedValueOnce({
      id: 'del-1',
      businessId: 'biz-1',
      source: 'API',
      sourceRef: 'ext-1',
      status: 'OUT_FOR_DELIVERY',
      paymentMethod: 'cod',
      cashToCollectMinor: 1000,
      cashCollectedMinor: 0,
      cashReceivedMinor: 0,
      cashChangeDueMinor: 0,
      customerName: 'Customer',
      currency: 'INR',
      trackingToken: 'tok',
      proofOtp: '4821',
    });

    await expect(updateDeliveryRequestStatus({
      businessId: 'biz-1',
      id: 'del-1',
      status: 'DELIVERED',
      patch: { cashCollectedMinor: 900 },
    })).rejects.toMatchObject({ reason: 'CASH_SHORT' });

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  test('records direct rider pickup and out-for-delivery timestamps', async () => {
    mockPrisma.ecomDeliveryRequest.findFirst.mockResolvedValue({
      id: 'del-1',
      businessId: 'biz-1',
      source: 'API',
      sourceRef: 'ext-1',
      status: 'ASSIGNED',
      paymentMethod: 'online',
      cashToCollectMinor: 0,
      cashCollectedMinor: 0,
      cashReceivedMinor: 0,
      cashChangeDueMinor: 0,
      customerName: 'Customer',
      currency: 'INR',
      trackingToken: 'tok',
      pickedUpAt: null,
    });

    await updateDeliveryRequestStatus({
      businessId: 'biz-1',
      id: 'del-1',
      status: 'PICKED_UP',
      actorSource: 'RIDER',
    });

    expect(mockPrisma.ecomDeliveryRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'del-1' },
      data: expect.objectContaining({
        status: 'PICKED_UP',
        pickedUpAt: expect.any(Date),
      }),
    }));
    expect(mockPrisma.ecomDeliveryRequestEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        businessId: 'biz-1',
        deliveryRequestId: 'del-1',
        kind: 'STATUS_CHANGED',
        fromStatus: 'ASSIGNED',
        toStatus: 'PICKED_UP',
        actorSource: 'RIDER',
      }),
    }));

    mockPrisma.ecomDeliveryRequest.findFirst.mockResolvedValue({
      id: 'del-1',
      businessId: 'biz-1',
      source: 'API',
      sourceRef: 'ext-1',
      status: 'PICKED_UP',
      paymentMethod: 'online',
      cashToCollectMinor: 0,
      cashCollectedMinor: 0,
      cashReceivedMinor: 0,
      cashChangeDueMinor: 0,
      customerName: 'Customer',
      currency: 'INR',
      trackingToken: 'tok',
    });

    await updateDeliveryRequestStatus({
      businessId: 'biz-1',
      id: 'del-1',
      status: 'OUT_FOR_DELIVERY',
      actorSource: 'RIDER',
    });

    expect(mockPrisma.ecomDeliveryRequest.update).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'del-1' },
      data: expect.objectContaining({
        status: 'OUT_FOR_DELIVERY',
      }),
    }));
  });

  test('accepts direct rider COD delivery when cash covers amount due', async () => {
    mockPrisma.ecomDeliveryRequest.findFirst.mockResolvedValueOnce({
      id: 'del-1',
      businessId: 'biz-1',
      source: 'API',
      sourceRef: 'ext-1',
      status: 'ARRIVED',
      paymentMethod: 'cod',
      cashToCollectMinor: 1000,
      cashCollectedMinor: 0,
      cashReceivedMinor: 0,
      cashChangeDueMinor: 0,
      customerName: 'Customer',
      currency: 'INR',
      trackingToken: 'tok',
    });

    const delivery = await updateDeliveryRequestStatus({
      businessId: 'biz-1',
      id: 'del-1',
      status: 'DELIVERED',
      patch: { cashReceivedMinor: 1200, cashChangeDueMinor: 200 },
      actorSource: 'RIDER',
    });

    expect(delivery.status).toBe('DELIVERED');
    expect(mockPrisma.ecomDeliveryRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        cashCollectedMinor: 1000,
        cashReceivedMinor: 1200,
        cashChangeDueMinor: 200,
        deliveredAt: expect.any(Date),
      }),
    }));
  });

  test('requires matching OTP for rider delivery completion', async () => {
    mockPrisma.ecomDeliveryRequest.findFirst.mockResolvedValue({
      id: 'del-1',
      businessId: 'biz-1',
      source: 'API',
      sourceRef: 'ext-1',
      status: 'ARRIVED',
      paymentMethod: 'online',
      cashToCollectMinor: 0,
      cashCollectedMinor: 0,
      cashReceivedMinor: 0,
      cashChangeDueMinor: 0,
      proofOtp: '4821',
      customerName: 'Customer',
      currency: 'INR',
      trackingToken: 'tok',
    });

    await expect(updateDeliveryRequestStatus({
      businessId: 'biz-1',
      id: 'del-1',
      status: 'DELIVERED',
      patch: { proofOtp: '1111' },
      actorSource: 'RIDER',
    })).rejects.toMatchObject({ reason: 'OTP_MISMATCH' });

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();

    const delivery = await updateDeliveryRequestStatus({
      businessId: 'biz-1',
      id: 'del-1',
      status: 'DELIVERED',
      patch: { proofOtp: '4821' },
      actorSource: 'RIDER',
    });

    expect(delivery.status).toBe('DELIVERED');
    expect(mockPrisma.ecomDeliveryRequestEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kind: 'STATUS_CHANGED',
        payload: expect.objectContaining({ proofOtpVerified: true }),
      }),
    }));
  });

  test('increments attempt count and stores retry time on failed attempt', async () => {
    const nextAttemptAt = '2026-06-10T12:30:00.000Z';
    mockPrisma.ecomDeliveryRequest.findFirst.mockResolvedValueOnce({
      id: 'del-1',
      businessId: 'biz-1',
      source: 'API',
      sourceRef: 'ext-1',
      status: 'OUT_FOR_DELIVERY',
      paymentMethod: 'online',
      cashToCollectMinor: 0,
      cashCollectedMinor: 0,
      cashReceivedMinor: 0,
      cashChangeDueMinor: 0,
      attemptCount: 1,
      nextAttemptAt: null,
      customerName: 'Customer',
      currency: 'INR',
      trackingToken: 'tok',
    });

    await updateDeliveryRequestStatus({
      businessId: 'biz-1',
      id: 'del-1',
      status: 'ATTEMPTED_FAILED',
      patch: { failureReason: 'No one home', nextAttemptAt, exceptionCode: 'CUSTOMER_UNREACHABLE', exceptionNote: 'No answer at door' },
      actorSource: 'RIDER',
    });

    expect(mockPrisma.ecomDeliveryRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'ATTEMPTED_FAILED',
        attemptCount: 2,
        nextAttemptAt: new Date(nextAttemptAt),
        failedAt: expect.any(Date),
        failureReason: 'No one home',
        exceptionCode: 'CUSTOMER_UNREACHABLE',
        exceptionStatus: 'OPEN',
        exceptionNote: 'No answer at door',
        exceptionOpenedAt: expect.any(Date),
      }),
    }));
    expect(mockPrisma.ecomDeliveryRequestEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kind: 'STATUS_CHANGED',
        toStatus: 'ATTEMPTED_FAILED',
        payload: expect.objectContaining({
          attemptCount: 2,
          nextAttemptAt: new Date(nextAttemptAt),
          exceptionCode: 'CUSTOMER_UNREACHABLE',
          exceptionStatus: 'OPEN',
        }),
      }),
    }));
  });

  test('escalates a delivery exception and emits an exception webhook', async () => {
    mockPrisma.ecomDeliveryRequest.findFirst.mockResolvedValueOnce({
      id: 'del-1',
      businessId: 'biz-1',
      source: 'API',
      sourceRef: 'ext-1',
      status: 'ATTEMPTED_FAILED',
      riderId: 'rider-1',
      paymentMethod: 'online',
      cashToCollectMinor: 0,
      cashCollectedMinor: 0,
      cashReceivedMinor: 0,
      cashChangeDueMinor: 0,
      attemptCount: 1,
      customerName: 'Customer',
      currency: 'INR',
      trackingToken: 'tok',
      exceptionCode: 'ADDRESS_ISSUE',
      exceptionStatus: 'OPEN',
      exceptionNote: 'Flat number missing',
      exceptionOpenedAt: new Date('2026-06-10T10:00:00.000Z'),
      exceptionEscalatedAt: null,
      exceptionResolvedAt: null,
    });

    const delivery = await updateDeliveryException({
      businessId: 'biz-1',
      id: 'del-1',
      exceptionCode: 'ADDRESS_ISSUE',
      exceptionStatus: 'ESCALATED',
      exceptionNote: 'Customer did not answer address confirmation',
      actorUserId: 'admin-1',
      actorSource: 'ADMIN',
    });

    expect(delivery.exceptionStatus).toBe('ESCALATED');
    expect(mockPrisma.ecomDeliveryRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        exceptionCode: 'ADDRESS_ISSUE',
        exceptionStatus: 'ESCALATED',
        exceptionNote: 'Customer did not answer address confirmation',
        exceptionEscalatedAt: expect.any(Date),
        exceptionResolvedAt: null,
      }),
    }));
    expect(mockPrisma.ecomDeliveryRequestEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kind: 'EXCEPTION_ESCALATED',
        actorUserId: 'admin-1',
        payload: expect.objectContaining({
          exceptionCode: 'ADDRESS_ISSUE',
          exceptionStatus: 'ESCALATED',
          exceptionLabel: 'Address issue',
        }),
      }),
    }));
    expect(safeEmit).toHaveBeenCalledWith(
      'delivery.exception_escalated',
      expect.objectContaining({ id: 'del-1', exceptionCode: 'ADDRESS_ISSUE', exceptionStatus: 'ESCALATED' }),
      'biz-1',
    );
  });

  test('keeps attempt count and clears retry time when reopening a failed delivery', async () => {
    mockPrisma.ecomDeliveryRequest.findFirst.mockResolvedValueOnce({
      id: 'del-1',
      businessId: 'biz-1',
      source: 'API',
      sourceRef: 'ext-1',
      status: 'ATTEMPTED_FAILED',
      riderId: 'rider-1',
      paymentMethod: 'online',
      cashToCollectMinor: 0,
      cashCollectedMinor: 0,
      cashReceivedMinor: 0,
      cashChangeDueMinor: 0,
      attemptCount: 2,
      nextAttemptAt: new Date('2026-06-10T12:30:00.000Z'),
      customerName: 'Customer',
      currency: 'INR',
      trackingToken: 'tok',
    });

    await updateDeliveryRequestStatus({
      businessId: 'biz-1',
      id: 'del-1',
      status: 'READY_FOR_DISPATCH',
      patch: { riderId: null },
      actorSource: 'ADMIN',
    });

    expect(mockPrisma.ecomDeliveryRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'READY_FOR_DISPATCH',
        riderId: null,
        attemptCount: 2,
        nextAttemptAt: null,
      }),
    }));
  });

  test('notifies the customer with a tracking link on delivery status change', async () => {
    const oldDomain = process.env.PLATFORM_DOMAIN;
    process.env.PLATFORM_DOMAIN = 'sitepresso.com';
    mockPrisma.ecomDeliveryRequest.findFirst.mockResolvedValueOnce({
      id: 'del-1',
      businessId: 'biz-1',
      source: 'API',
      sourceRef: 'ext-1',
      status: 'ASSIGNED',
      paymentMethod: 'online',
      cashToCollectMinor: 0,
      cashCollectedMinor: 0,
      cashReceivedMinor: 0,
      cashChangeDueMinor: 0,
      customerName: 'Customer',
      customerPhone: '+919000000000',
      customerEmail: 'customer@example.com',
      dropoffCountry: 'IN',
      currency: 'INR',
      trackingToken: 'tok',
      proofOtp: '4821',
    });

    try {
      await updateDeliveryRequestStatus({
        businessId: 'biz-1',
        id: 'del-1',
        status: 'OUT_FOR_DELIVERY',
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({
        businessId: 'biz-1',
        recipientPhone: '+919000000000',
        recipientEmail: 'customer@example.com',
        templateKey: 'DELIVERY_OUT_FOR_DELIVERY',
        triggeredBy: 'DELIVERY_OUT_FOR_DELIVERY',
        variables: expect.objectContaining({
          BIZ: 'Shop',
          ID: 'ext-1',
          LINK: 'https://shop.sitepresso.com/delivery/tok',
          OTP: '4821',
        }),
      }));
    } finally {
      if (oldDomain === undefined) delete process.env.PLATFORM_DOMAIN;
      else process.env.PLATFORM_DOMAIN = oldDomain;
    }
  });

  test('stores customer feedback for a delivered tracking link', async () => {
    mockPrisma.ecomDeliveryRequest.findFirst.mockResolvedValueOnce({
      id: 'del-1',
      businessId: 'biz-1',
      status: 'DELIVERED',
      trackingToken: 'tok',
    });

    const saved = await submitDeliveryCustomerFeedback({
      trackingToken: 'tok',
      customerRating: 5,
      customerFeedback: 'Fast and careful',
    });

    expect(saved.customerRating).toBe(5);
    expect(saved.customerFeedback).toBe('Fast and careful');
    expect(mockPrisma.ecomDeliveryRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'del-1' },
      data: {
        customerRating: 5,
        customerFeedback: 'Fast and careful',
      },
    }));
    expect(mockPrisma.ecomDeliveryRequestEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        businessId: 'biz-1',
        deliveryRequestId: 'del-1',
        kind: 'CUSTOMER_FEEDBACK',
        actorSource: 'CUSTOMER',
        payload: {
          customerRating: 5,
          customerFeedback: 'Fast and careful',
        },
      }),
    }));
  });

  test('rejects customer feedback before delivery is complete', async () => {
    mockPrisma.ecomDeliveryRequest.findFirst.mockResolvedValueOnce({
      id: 'del-1',
      businessId: 'biz-1',
      status: 'OUT_FOR_DELIVERY',
      trackingToken: 'tok',
    });

    await expect(submitDeliveryCustomerFeedback({
      trackingToken: 'tok',
      customerRating: 4,
      customerFeedback: 'Almost here',
    })).rejects.toMatchObject({ status: 409, reason: 'DELIVERY_NOT_COMPLETED' });

    expect(mockPrisma.ecomDeliveryRequest.update).not.toHaveBeenCalled();
    expect(mockPrisma.ecomDeliveryRequestEvent.create).not.toHaveBeenCalled();
  });

  test('builds tenant delivery tracking paths and URLs', () => {
    const oldDomain = process.env.PLATFORM_DOMAIN;
    process.env.PLATFORM_DOMAIN = 'aapkatech.com';

    try {
      const row = { trackingToken: 'track_123' };
      expect(deliveryTrackingPath(row)).toBe('/delivery/track_123');
      expect(deliveryTrackingUrl(row, 'pizza-shop')).toBe('https://pizza-shop.aapkatech.com/delivery/track_123');
      expect(deliveryTrackingUrl(row)).toBe(null);
    } finally {
      if (oldDomain === undefined) delete process.env.PLATFORM_DOMAIN;
      else process.env.PLATFORM_DOMAIN = oldDomain;
    }
  });

  test('marks promised deliveries as breached once due time has passed', () => {
    const dispatch = computeDeliveryDispatchMeta({
      id: 'del-1',
      status: 'READY_FOR_DISPATCH',
      promisedAt: new Date('2026-06-10T09:00:00.000Z'),
      priority: 'NORMAL',
    }, { now: new Date('2026-06-10T09:20:00.000Z') });

    expect(dispatch.slaStatus).toBe('BREACHED');
    expect(dispatch.minutesUntilDue).toBe(-20);
    expect(dispatch.recommendedAction).toBe('Escalate late delivery');
    expect(dispatch.urgencyScore).toBeGreaterThan(100);
  });

  test('uses rider location and dropoff coordinates to flag at-risk ETA', () => {
    const dispatch = computeDeliveryDispatchMeta({
      id: 'del-1',
      status: 'OUT_FOR_DELIVERY',
      promisedAt: new Date('2026-06-10T10:20:00.000Z'),
      priority: 'NORMAL',
      dropoffLat: 28.6139,
      dropoffLng: 77.2090,
      locationPings: [{
        lat: 28.7041,
        lng: 77.1025,
        createdAt: new Date('2026-06-10T10:00:00.000Z'),
      }],
    }, { now: new Date('2026-06-10T10:00:00.000Z') });

    expect(dispatch.slaStatus).toBe('AT_RISK');
    expect(dispatch.eta.basedOn).toBe('RIDER_LOCATION');
    expect(dispatch.eta.distanceMeters).toBeGreaterThan(0);
    expect(dispatch.eta.etaDeltaMinutes).toBeGreaterThan(0);
    expect(dispatch.recommendedAction).toBe('Contact rider');
  });

  test('completed deliveries do not keep active dispatch pressure', () => {
    const dispatch = computeDeliveryDispatchMeta({
      id: 'del-1',
      status: 'DELIVERED',
      promisedAt: new Date('2026-06-10T09:00:00.000Z'),
      deliveredAt: new Date('2026-06-10T08:55:00.000Z'),
    }, { now: new Date('2026-06-10T10:00:00.000Z') });

    expect(dispatch.slaStatus).toBe('COMPLETE');
    expect(dispatch.recommendedAction).toBe('No action needed');
    expect(dispatch.urgencyScore).toBe(0);
    expect(dispatch.eta.estimatedArrivalAt).toBe(null);
  });

  test('scheduled retry attempts reduce exception pressure until due', () => {
    const dispatch = computeDeliveryDispatchMeta({
      id: 'del-1',
      status: 'ATTEMPTED_FAILED',
      exceptionStatus: 'OPEN',
      nextAttemptAt: new Date('2026-06-10T12:00:00.000Z'),
    }, { now: new Date('2026-06-10T10:00:00.000Z') });

    expect(dispatch.slaStatus).toBe('ON_TRACK');
    expect(dispatch.recommendedAction).toBe('Retry scheduled');
    expect(dispatch.retry.minutesUntilRetry).toBe(120);
    expect(dispatch.urgencyScore).toBe(20);
  });

  test('due retry attempts are promoted back into dispatcher action', () => {
    const dispatch = computeDeliveryDispatchMeta({
      id: 'del-1',
      status: 'ATTEMPTED_FAILED',
      exceptionStatus: 'OPEN',
      nextAttemptAt: new Date('2026-06-10T09:50:00.000Z'),
    }, { now: new Date('2026-06-10T10:00:00.000Z') });

    expect(dispatch.slaStatus).toBe('EXCEPTION');
    expect(dispatch.recommendedAction).toBe('Retry due');
    expect(dispatch.retry.isDue).toBe(true);
    expect(dispatch.urgencyScore).toBe(80);
  });
});
