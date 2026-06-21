const mockPrisma = {
  ecomRider: { findFirst: jest.fn() },
  ecomDeliveryRoute: { findFirst: jest.fn() },
  ecomDeliveryRequest: { findFirst: jest.fn() },
  order: { findFirst: jest.fn() },
  $transaction: jest.fn(),
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

jest.mock('../src/core/lib/ecomRiderShiftService', () => ({
  assertRiderOnShift: jest.fn().mockResolvedValue(true),
  endRiderShift: jest.fn(),
  findActiveRiderShift: jest.fn(),
  shiftDTO: jest.fn((shift) => shift),
  shiftDTOWithCashSummary: jest.fn((shift) => shift),
  startRiderShift: jest.fn(),
}));

jest.mock('../src/core/lib/ecomDeliveryRequestService', () => ({
  DELIVERY_EXCEPTION_CODES: ['CUSTOMER_UNREACHABLE', 'ADDRESS_ISSUE', 'OTHER'],
  STATUS_EVENTS: {},
  allowedDeliveryStatusTransitions: jest.fn(() => []),
  canTransitionDeliveryStatus: jest.fn(() => false),
  deliveryStatusLabel: jest.fn((status) => status),
  deliveryWebhookPayload: jest.fn((delivery) => delivery),
  notifyDeliveryCustomer: jest.fn(),
  recordDeliveryEvent: jest.fn(),
  updateDeliveryRequestStatus: jest.fn(),
}));

jest.mock('../src/core/lib/ecomActivityLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../src/core/lib/webhookDispatcher', () => ({ safeEmit: jest.fn() }));
jest.mock('../src/core/utils/email', () => ({
  sendRiderInviteEmail: jest.fn(),
  sendOrderDeliveryAttemptFailedEmail: jest.fn(),
}));

const { updateRiderStopStatus } = require('../src/shop/controllers/ecomRiders.controller');

function res() {
  const response = { statusCode: 200, body: null };
  response.status = jest.fn((code) => { response.statusCode = code; return response; });
  response.json = jest.fn((body) => { response.body = body; return response; });
  return response;
}

describe('ecomRiders.updateRiderStopStatus lifecycle guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.ecomRider.findFirst.mockResolvedValue({
      id: 'rider-1',
      businessId: 'biz-1',
      userId: 'user-1',
      fullName: 'Rider One',
    });
    mockPrisma.ecomDeliveryRoute.findFirst.mockResolvedValue({
      id: 'route-1',
      businessId: 'biz-1',
      riderId: 'rider-1',
      status: 'DISPATCHED',
      code: 'RT-001',
      stops: [{
        id: 'stop-1',
        routeId: 'route-1',
        orderId: null,
        deliveryRequestId: 'delivery-1',
        status: 'OUT_FOR_DELIVERY',
        cashCollectedMinor: 0,
        cashReceivedMinor: 0,
        cashChangeDueMinor: 0,
      }],
    });
    mockPrisma.ecomDeliveryRequest.findFirst.mockResolvedValue({
      id: 'delivery-1',
      businessId: 'biz-1',
      status: 'CANCELLED',
      source: 'API',
      sourceRef: 'ORDER-1',
      orderId: null,
      riderId: 'rider-1',
      attemptCount: 0,
      proofOtp: null,
    });
  });

  test('blocks route stop writes that would reopen a terminal linked delivery', async () => {
    const out = res();

    await updateRiderStopStatus({
      user: { id: 'user-1', businessId: 'biz-1' },
      params: { routeId: 'route-1', stopId: 'stop-1' },
      body: { status: 'DELIVERED' },
    }, out);

    expect(out.statusCode).toBe(409);
    expect(out.body).toMatchObject({
      reason: 'INVALID_STATUS_TRANSITION',
      message: 'Cannot transition delivery from CANCELLED to DELIVERED',
      allowedTransitions: [],
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
