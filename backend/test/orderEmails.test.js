// Tests for the sendOrderEmails orchestration in order.controller. Mocks
// both Prisma + the email senders so we verify what addresses get
// dispatched, in what shape, without touching SES or DB.

jest.mock('../src/core/lib/prisma', () => ({
  business: { findUnique: jest.fn() },
  user: { findFirst: jest.fn() },
}));

jest.mock('../src/core/utils/email', () => ({
  sendOrderReceivedCustomerEmail: jest.fn(),
  sendOrderReceivedAdminEmail: jest.fn(),
}));

const prisma = require('../src/core/lib/prisma');
const email = require('../src/core/utils/email');
const { sendOrderEmails } = require('../src/shop/controllers/order.controller');

const BIZ = {
  id: 'biz-1',
  name: 'Acme Grocers',
  slug: 'acme-grocers',
  email: 'shop@acme.example',
};

const BASE_ORDER = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  customerEmail: 'shopper@example.com',
  customerName: 'Anjali Sharma',
  customerPhone: '+91 99999 11111',
  shippingAddress: { line1: '12 Test Lane', city: 'Mumbai', postalCode: '400001', country: 'IN' },
  currency: 'INR',
  subtotalMinor: 24500,
  shippingMinor: 0,
  taxMinor: 0,
  totalMinor: 24500,
  notes: null,
  items: [
    { id: 'oi-1', productName: 'Wholewheat bread', quantity: 2, priceMinor: 12250, lineTotalMinor: 24500 },
  ],
};

beforeEach(() => {
  prisma.business.findUnique.mockReset();
  prisma.user.findFirst.mockReset();
  email.sendOrderReceivedCustomerEmail.mockReset();
  email.sendOrderReceivedAdminEmail.mockReset();
});

describe('sendOrderEmails', () => {
  test('sends to customer + first BUSINESS_ADMIN user', async () => {
    prisma.business.findUnique.mockResolvedValueOnce(BIZ);
    prisma.user.findFirst.mockResolvedValueOnce({ id: 'u-1', email: 'owner@acme.example', name: 'Owner' });

    await sendOrderEmails({ order: BASE_ORDER, business: { id: BIZ.id } });

    expect(email.sendOrderReceivedCustomerEmail).toHaveBeenCalledTimes(1);
    expect(email.sendOrderReceivedCustomerEmail).toHaveBeenCalledWith(
      'shopper@example.com',
      expect.objectContaining({
        businessName: 'Acme Grocers',
        customerName: 'Anjali Sharma',
        orderShortId: '550e8400',
        totalMinor: 24500,
        currency: 'INR',
      }),
    );

    expect(email.sendOrderReceivedAdminEmail).toHaveBeenCalledTimes(1);
    expect(email.sendOrderReceivedAdminEmail).toHaveBeenCalledWith(
      'owner@acme.example',
      expect.objectContaining({
        businessName: 'Acme Grocers',
        customerEmail: 'shopper@example.com',
        orderId: BASE_ORDER.id,
      }),
    );
  });

  test('falls back to business.email if no admin user', async () => {
    prisma.business.findUnique.mockResolvedValueOnce(BIZ);
    prisma.user.findFirst.mockResolvedValueOnce(null);

    await sendOrderEmails({ order: BASE_ORDER, business: { id: BIZ.id } });

    expect(email.sendOrderReceivedAdminEmail).toHaveBeenCalledWith(
      'shop@acme.example',
      expect.any(Object),
    );
  });

  test('skips admin email if neither admin user nor business.email exists', async () => {
    prisma.business.findUnique.mockResolvedValueOnce({ ...BIZ, email: null });
    prisma.user.findFirst.mockResolvedValueOnce(null);

    await sendOrderEmails({ order: BASE_ORDER, business: { id: BIZ.id } });

    expect(email.sendOrderReceivedCustomerEmail).toHaveBeenCalledTimes(1);
    expect(email.sendOrderReceivedAdminEmail).not.toHaveBeenCalled();
  });

  test('returns silently when business no longer exists', async () => {
    prisma.business.findUnique.mockResolvedValueOnce(null);
    prisma.user.findFirst.mockResolvedValueOnce(null);

    await sendOrderEmails({ order: BASE_ORDER, business: { id: BIZ.id } });

    expect(email.sendOrderReceivedCustomerEmail).not.toHaveBeenCalled();
    expect(email.sendOrderReceivedAdminEmail).not.toHaveBeenCalled();
  });

  test('returns silently when no order or no business arg', async () => {
    await sendOrderEmails({ order: null, business: BIZ });
    await sendOrderEmails({ order: BASE_ORDER, business: null });
    expect(prisma.business.findUnique).not.toHaveBeenCalled();
  });

  test('builds storefront orderUrl + admin orderUrl from PLATFORM_DOMAIN', async () => {
    const oldDomain = process.env.PLATFORM_DOMAIN;
    const oldProto = process.env.PLATFORM_PROTOCOL;
    process.env.PLATFORM_DOMAIN = 'sitepresso.test';
    process.env.PLATFORM_PROTOCOL = 'https';
    prisma.business.findUnique.mockResolvedValueOnce(BIZ);
    prisma.user.findFirst.mockResolvedValueOnce({ id: 'u-1', email: 'owner@acme.example', name: 'Owner' });

    await sendOrderEmails({ order: BASE_ORDER, business: { id: BIZ.id } });

    const customerCtx = email.sendOrderReceivedCustomerEmail.mock.calls[0][1];
    expect(customerCtx.orderUrl).toBe(
      `https://acme-grocers.sitepresso.test/orders/${BASE_ORDER.id}?email=${encodeURIComponent(BASE_ORDER.customerEmail)}`,
    );

    const adminCtx = email.sendOrderReceivedAdminEmail.mock.calls[0][1];
    expect(adminCtx.adminUrl).toBe('https://sitepresso.test/acme-grocers/admin?tab=orders');

    process.env.PLATFORM_DOMAIN = oldDomain;
    process.env.PLATFORM_PROTOCOL = oldProto;
  });
});
