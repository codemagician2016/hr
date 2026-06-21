// Tests for the per-status order email dispatcher in order.controller.
// Mocks Prisma + the email senders so we verify the right sender fires
// for each status transition, with the right ctx shape.

jest.mock('../src/core/lib/prisma', () => ({
  business: { findUnique: jest.fn() },
}));

jest.mock('../src/core/utils/email', () => ({
  sendOrderReceivedCustomerEmail: jest.fn(),
  sendOrderReceivedAdminEmail: jest.fn(),
  sendOrderPaidEmail: jest.fn(),
  sendOrderOutForDeliveryEmail: jest.fn(),
  sendOrderDeliveredEmail: jest.fn(),
}));

const prisma = require('../src/core/lib/prisma');
const email = require('../src/core/utils/email');
const {
  STATUS_EMAIL_SENDERS,
  sendStatusEmail,
} = require('../src/shop/controllers/order.controller');

const BIZ = {
  id: 'biz-1',
  name: 'Acme Grocers',
  slug: 'acme-grocers',
  email: 'shop@acme.example',
};

const BASE_ORDER = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  businessId: BIZ.id,
  customerEmail: 'shopper@example.com',
  customerName: 'Anjali Sharma',
  customerPhone: null,
  shippingAddress: { line1: '12 Test Lane', city: 'Mumbai', postalCode: '400001', country: 'IN' },
  currency: 'INR',
  subtotalMinor: 24500,
  shippingMinor: 0,
  taxMinor: 0,
  totalMinor: 24500,
  notes: null,
  items: [
    { id: 'oi-1', productName: 'Whole Wheat Bread', quantity: 2, priceMinor: 12250, lineTotalMinor: 24500 },
  ],
};

beforeEach(() => {
  prisma.business.findUnique.mockReset();
  Object.values(email).forEach((fn) => fn.mockReset && fn.mockReset());
});

describe('STATUS_EMAIL_SENDERS map', () => {
  test('PAID maps to sendOrderPaidEmail', () => {
    expect(STATUS_EMAIL_SENDERS.PAID).toBe(email.sendOrderPaidEmail);
  });
  test('OUT_FOR_DELIVERY maps to sendOrderOutForDeliveryEmail', () => {
    expect(STATUS_EMAIL_SENDERS.OUT_FOR_DELIVERY).toBe(email.sendOrderOutForDeliveryEmail);
  });
  test('DELIVERED maps to sendOrderDeliveredEmail', () => {
    expect(STATUS_EMAIL_SENDERS.DELIVERED).toBe(email.sendOrderDeliveredEmail);
  });
  test('PACKING / CANCELLED / REFUNDED have no auto-email', () => {
    expect(STATUS_EMAIL_SENDERS.PACKING).toBeUndefined();
    expect(STATUS_EMAIL_SENDERS.CANCELLED).toBeUndefined();
    expect(STATUS_EMAIL_SENDERS.REFUNDED).toBeUndefined();
    expect(STATUS_EMAIL_SENDERS.PENDING).toBeUndefined();
    expect(STATUS_EMAIL_SENDERS.FAILED).toBeUndefined();
  });
});

describe('sendStatusEmail', () => {
  test('builds ctx and calls the sender for PAID', async () => {
    prisma.business.findUnique.mockResolvedValueOnce(BIZ);

    await sendStatusEmail(BASE_ORDER, email.sendOrderPaidEmail);

    expect(email.sendOrderPaidEmail).toHaveBeenCalledTimes(1);
    expect(email.sendOrderPaidEmail).toHaveBeenCalledWith(
      'shopper@example.com',
      expect.objectContaining({
        businessName: 'Acme Grocers',
        customerName: 'Anjali Sharma',
        orderShortId: '550e8400',
        totalMinor: 24500,
        currency: 'INR',
        items: BASE_ORDER.items,
        supportEmail: 'shop@acme.example',
      }),
    );
  });

  test('returns silently when business no longer exists', async () => {
    prisma.business.findUnique.mockResolvedValueOnce(null);
    await sendStatusEmail(BASE_ORDER, email.sendOrderPaidEmail);
    expect(email.sendOrderPaidEmail).not.toHaveBeenCalled();
  });

  test('composes orderUrl from PLATFORM_DOMAIN env', async () => {
    const oldDomain = process.env.PLATFORM_DOMAIN;
    const oldProto = process.env.PLATFORM_PROTOCOL;
    process.env.PLATFORM_DOMAIN = 'sitepresso.test';
    process.env.PLATFORM_PROTOCOL = 'https';
    prisma.business.findUnique.mockResolvedValueOnce(BIZ);

    await sendStatusEmail(BASE_ORDER, email.sendOrderDeliveredEmail);

    const ctx = email.sendOrderDeliveredEmail.mock.calls[0][1];
    expect(ctx.orderUrl).toBe(
      `https://acme-grocers.sitepresso.test/orders/${BASE_ORDER.id}?email=${encodeURIComponent(BASE_ORDER.customerEmail)}`,
    );

    process.env.PLATFORM_DOMAIN = oldDomain;
    process.env.PLATFORM_PROTOCOL = oldProto;
  });

  test('passes through items + currency for OUT_FOR_DELIVERY (used in template)', async () => {
    prisma.business.findUnique.mockResolvedValueOnce(BIZ);
    await sendStatusEmail(BASE_ORDER, email.sendOrderOutForDeliveryEmail);

    const ctx = email.sendOrderOutForDeliveryEmail.mock.calls[0][1];
    expect(ctx.items).toHaveLength(1);
    expect(ctx.items[0].productName).toBe('Whole Wheat Bread');
    expect(ctx.currency).toBe('INR');
    expect(ctx.shippingAddress.city).toBe('Mumbai');
  });
});
