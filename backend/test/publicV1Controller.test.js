const mockEcomRider = { findFirst: jest.fn() };
const mockEcomDeliveryRequest = {
  findMany: jest.fn(),
  count: jest.fn(),
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => ({
    ecomRider: mockEcomRider,
    ecomDeliveryRequest: mockEcomDeliveryRequest,
  })),
}));

const mockCreateDeliveryRequest = jest.fn();
const mockUpdateDeliveryRequestStatus = jest.fn();

jest.mock('../src/core/lib/ecomDeliveryRequestService', () => ({
  DELIVERY_SOURCES: ['SITEPRESSO', 'API', 'MANUAL'],
  DELIVERY_EXCEPTION_CODES: ['CUSTOMER_UNREACHABLE', 'ADDRESS_ISSUE', 'OTHER'],
  DELIVERY_EXCEPTION_STATUSES: ['OPEN', 'ESCALATED', 'RESOLVED'],
  DELIVERY_STATUSES: ['PENDING', 'READY_FOR_DISPATCH', 'ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED', 'ATTEMPTED_FAILED', 'CANCELLED', 'RETURNED'],
  computeDeliveryDispatchMeta: jest.fn(() => ({ urgencyScore: 0, retry: { isDue: false } })),
  createDeliveryRequest: mockCreateDeliveryRequest,
  deliveryEventDTO: jest.fn((event) => event),
  deliveryTrackingPath: jest.fn(() => '/delivery/tok'),
  deliveryTrackingUrl: jest.fn(() => 'https://shop.example/delivery/tok'),
  latestDeliveryLocation: jest.fn(() => null),
  updateDeliveryException: jest.fn(),
  updateDeliveryRequestStatus: mockUpdateDeliveryRequestStatus,
}));

const controller = require('../src/core/controllers/publicV1.controller');

function res() {
  const r = { statusCode: 200, body: null };
  r.status = jest.fn((code) => { r.statusCode = code; return r; });
  r.json = jest.fn((body) => { r.body = body; return r; });
  return r;
}

function req({ body = {}, params = {}, query = {} } = {}) {
  return {
    body,
    params,
    query,
    business: { id: 'biz-1', slug: 'pizza-house', name: 'Pizza House' },
    apiKey: { id: 'key-1', name: 'Delivery key', scopes: { read: ['deliveries'], write: ['deliveries'] } },
  };
}

function delivery(overrides = {}) {
  return {
    id: 'del-1',
    businessId: 'biz-1',
    source: 'API',
    sourceRef: 'ORDER-1',
    channel: null,
    status: 'ASSIGNED',
    priority: 'NORMAL',
    locationId: null,
    orderId: null,
    riderId: 'rider-1',
    customerName: 'Priya',
    customerPhone: '+919000000000',
    customerEmail: null,
    items: [],
    currency: 'INR',
    paymentMethod: 'cod',
    cashToCollectMinor: 1200,
    cashCollectedMinor: 0,
    cashReceivedMinor: 0,
    cashChangeDueMinor: 0,
    trackingToken: 'tok',
    createdAt: new Date('2026-06-10T10:00:00.000Z'),
    updatedAt: new Date('2026-06-10T10:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('publicV1 delivery rider reference resolution', () => {
  test('createDelivery resolves riderPhone to riderId before creating the delivery', async () => {
    mockEcomRider.findFirst.mockResolvedValue({ id: 'rider-1' });
    mockCreateDeliveryRequest.mockResolvedValue({ created: true, delivery: delivery() });

    const out = res();
    await controller.createDelivery(req({
      body: {
        externalRef: 'ORDER-1',
        riderPhone: '+919000000000',
        customerName: 'Priya',
        dropoff: { line1: '12 Market Road' },
      },
    }), out);

    expect(out.statusCode).toBe(201);
    expect(mockEcomRider.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        businessId: 'biz-1',
        status: { in: ['ACTIVE', 'OFF_SHIFT'] },
        OR: [{ phone: '+919000000000' }],
      }),
    }));
    expect(mockCreateDeliveryRequest).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'biz-1',
      input: expect.objectContaining({
        source: 'API',
        sourceRef: 'ORDER-1',
        riderId: 'rider-1',
        status: 'ASSIGNED',
      }),
    }));
    expect(mockCreateDeliveryRequest.mock.calls[0][0].input.riderPhone).toBeUndefined();
  });

  test('createDelivery rejects unknown riderEmail references', async () => {
    mockEcomRider.findFirst.mockResolvedValue(null);

    const out = res();
    await controller.createDelivery(req({
      body: {
        externalRef: 'ORDER-2',
        riderEmail: 'driver@example.com',
        customerName: 'Priya',
        dropoff: { line1: '12 Market Road' },
      },
    }), out);

    expect(out.statusCode).toBe(404);
    expect(out.body).toMatchObject({ error: 'RIDER_NOT_FOUND' });
    expect(mockCreateDeliveryRequest).not.toHaveBeenCalled();
  });

  test('updateDeliveryStatus resolves riderEmail assignment before updating status', async () => {
    mockEcomRider.findFirst.mockResolvedValue({ id: 'rider-2' });
    mockUpdateDeliveryRequestStatus.mockResolvedValue(delivery({ riderId: 'rider-2' }));

    const out = res();
    await controller.updateDeliveryStatus(req({
      params: { id: 'del-1' },
      body: {
        status: 'ASSIGNED',
        riderEmail: 'driver@example.com',
      },
    }), out);

    expect(out.statusCode).toBe(200);
    expect(mockEcomRider.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [{ email: { equals: 'driver@example.com', mode: 'insensitive' } }],
      }),
    }));
    expect(mockUpdateDeliveryRequestStatus).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'biz-1',
      id: 'del-1',
      status: 'ASSIGNED',
      patch: expect.objectContaining({ riderId: 'rider-2' }),
      actorSource: 'API',
    }));
    expect(mockUpdateDeliveryRequestStatus.mock.calls[0][0].patch.riderEmail).toBeUndefined();
  });

  test('createDeliveriesBulk returns per-delivery results with partial failures', async () => {
    mockEcomRider.findFirst.mockResolvedValue(null);
    mockCreateDeliveryRequest.mockResolvedValueOnce({
      created: true,
      delivery: delivery({ id: 'del-ok', sourceRef: 'ORDER-OK', status: 'PENDING', riderId: null }),
    });

    const out = res();
    await controller.createDeliveriesBulk(req({
      body: {
        deliveries: [
          {
            externalRef: 'ORDER-OK',
            customerName: 'Priya',
            dropoff: { line1: '12 Market Road' },
          },
          {
            externalRef: 'ORDER-BAD-RIDER',
            riderPhone: '+919999999999',
            customerName: 'Aman',
            dropoff: { line1: '18 Park Road' },
          },
        ],
      },
    }), out);

    expect(out.statusCode).toBe(207);
    expect(out.body.summary).toEqual({
      total: 2,
      created: 1,
      idempotent: 0,
      failed: 1,
    });
    expect(out.body.data[0]).toMatchObject({ index: 0, externalRef: 'ORDER-OK', ok: true });
    expect(out.body.data[1]).toMatchObject({
      index: 1,
      externalRef: 'ORDER-BAD-RIDER',
      ok: false,
      error: 'RIDER_NOT_FOUND',
    });
    expect(mockCreateDeliveryRequest).toHaveBeenCalledTimes(1);
    expect(mockCreateDeliveryRequest.mock.calls[0][0].input).toEqual(expect.objectContaining({
      sourceRef: 'ORDER-OK',
      status: 'PENDING',
    }));
  });
});

describe('publicV1 delivery list filters', () => {
  test('filters delivery sync lists by status set, rider, and timestamps', async () => {
    mockEcomDeliveryRequest.count.mockResolvedValue(1);
    mockEcomDeliveryRequest.findMany.mockResolvedValue([
      delivery({ status: 'OUT_FOR_DELIVERY', riderId: 'rider-1' }),
    ]);

    const out = res();
    await controller.listDeliveries(req({
      query: {
        status: 'assigned,out_for_delivery',
        riderId: 'rider-1',
        updatedSince: '2026-06-10T10:00:00.000Z',
        createdSince: '2026-06-01T00:00:00.000Z',
        sort: 'dispatch',
      },
    }), out);

    expect(out.statusCode).toBe(200);
    expect(mockEcomDeliveryRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        businessId: 'biz-1',
        riderId: 'rider-1',
        status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] },
        updatedAt: { gte: new Date('2026-06-10T10:00:00.000Z') },
        createdAt: { gte: new Date('2026-06-01T00:00:00.000Z') },
      }),
      orderBy: [{ promisedAt: 'asc' }, { requestedDropoffAt: 'asc' }, { createdAt: 'asc' }],
    }));
    expect(out.body).toMatchObject({
      page: 1,
      perPage: 50,
      total: 1,
      data: [expect.objectContaining({ status: 'OUT_FOR_DELIVERY', riderId: 'rider-1' })],
    });
  });

  test('rejects invalid comma-separated delivery statuses', async () => {
    const out = res();
    await controller.listDeliveries(req({
      query: { status: 'DELIVERED,BOGUS' },
    }), out);

    expect(out.statusCode).toBe(400);
    expect(out.body).toMatchObject({
      error: 'invalid_request',
      message: 'Invalid delivery status: BOGUS',
    });
    expect(mockEcomDeliveryRequest.findMany).not.toHaveBeenCalled();
  });
});

describe('publicV1 delivery OpenAPI endpoint', () => {
  test('returns a tenant-scoped OpenAPI delivery contract', async () => {
    const out = res();

    await controller.deliveryOpenApi(req(), out);

    expect(out.statusCode).toBe(200);
    expect(out.body).toMatchObject({
      openapi: '3.1.0',
      info: expect.objectContaining({ title: expect.stringContaining('AapkaRider') }),
      'x-sitepresso-business': expect.objectContaining({ slug: 'pizza-house' }),
    });
    expect(out.body.paths['/deliveries/openapi.json']).toBeDefined();
    expect(out.body.paths['/deliveries'].get.parameters.map((param) => param.name)).toEqual(expect.arrayContaining([
      'status',
      'updatedSince',
      'riderId',
    ]));
    expect(out.body.components.schemas.Delivery.properties.status.enum).toEqual(expect.arrayContaining([
      'OUT_FOR_DELIVERY',
      'DELIVERED',
    ]));
  });
});
