// BYO India Razorpay: connecting the tenant's own keys + the per-tenant webhook.
// Locks the model where each India tenant brings their own Razorpay account and
// Sitepresso verifies with THAT tenant's secret (never a platform secret).

jest.mock('@prisma/client', () => {
  const business = { findUnique: jest.fn() };
  const businessPaymentAccount = { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn(), update: jest.fn() };
  const order = { findUnique: jest.fn(), updateMany: jest.fn() };
  return {
    PrismaClient: jest.fn(() => ({ business, businessPaymentAccount, order })),
    __business: business, __bpa: businessPaymentAccount, __order: order,
  };
});
jest.mock('../src/core/lib/crypto', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
}));
jest.mock('../src/core/lib/razorpayRoute', () => ({
  validateKeys: jest.fn(),
  verifyWebhookSignatureWithSecret: jest.fn(),
}));
jest.mock('../src/core/lib/stripeConnect', () => ({ isConfigured: () => false }));
jest.mock('../src/shop/controllers/order.controller', () => ({
  clearCartOnPaidOrder: jest.fn(() => Promise.resolve()),
  confirmSlotBookingForOrder: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/shop/controllers/storefrontLoyalty.controller', () => ({ grantOnPaidOrder: jest.fn(() => Promise.resolve()) }));
jest.mock('../src/core/lib/webhookDispatcher', () => ({ safeEmit: jest.fn() }));

const { __business: business, __bpa: bpa, __order: order } = require('@prisma/client');
const razorpay = require('../src/core/lib/razorpayRoute');
const { clearCartOnPaidOrder } = require('../src/shop/controllers/order.controller');
const { razorpayConnectKeys, razorpayWebhook } = require('../src/core/controllers/payments.controller');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  res.send = jest.fn((b) => { res.body = b; return res; });
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  business.findUnique.mockResolvedValue({ id: 'biz-1', name: 'Shop', slug: 'shop', email: 'a@b.c', phone: '9', country: 'IN', defaultCurrency: 'INR' });
});

describe('razorpayConnectKeys (BYO connect)', () => {
  test('validates the keys, stores them ENCRYPTED, marks the account ACTIVE', async () => {
    razorpay.validateKeys.mockResolvedValue({ ok: true, mode: 'test' });
    bpa.upsert.mockImplementation(async ({ create }) => ({ id: 'acc1', ...create }));

    const req = { user: { businessId: 'biz-1' }, body: { keyId: 'rzp_test_abc', keySecret: 'sekretkey9', webhookSecret: 'whsekret1' } };
    const res = mockRes();
    await razorpayConnectKeys(req, res);

    expect(razorpay.validateKeys).toHaveBeenCalledWith({ keyId: 'rzp_test_abc', keySecret: 'sekretkey9' });
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('ACTIVE');
    const meta = bpa.upsert.mock.calls[0][0].create.metadata;
    expect(meta.connectionModel).toBe('BYO_KEYS');
    expect(meta.keyId).toBe('rzp_test_abc');
    expect(meta.keySecretEncrypted).toBe('enc:sekretkey9');     // encrypted at rest
    expect(meta.webhookSecretEncrypted).toBe('enc:whsekret1');
    // The raw secret must never be echoed back to the client.
    expect(JSON.stringify(res.body)).not.toContain('sekretkey9');
  });

  test('rejects keys that do not authenticate against Razorpay', async () => {
    razorpay.validateKeys.mockResolvedValue({ ok: false, message: 'bad keys' });
    const req = { user: { businessId: 'biz-1' }, body: { keyId: 'rzp_test_abc', keySecret: 'wrongkey9' } };
    const res = mockRes();
    await razorpayConnectKeys(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('RAZORPAY_KEYS_INVALID');
    expect(bpa.upsert).not.toHaveBeenCalled();
  });
});

describe('razorpayWebhook (BYO per-tenant secret)', () => {
  const BYO_ACCOUNT = { provider: 'RAZORPAY', metadata: { connectionModel: 'BYO_KEYS', keyId: 'rzp_test_abc', webhookSecretEncrypted: 'enc:whsek' } };
  function webhookReq(entity) {
    const payload = { event: 'payment.captured', payload: { payment: { entity } } };
    return { body: Buffer.from(JSON.stringify(payload)), headers: { 'x-razorpay-signature': 'sig' } };
  }

  test('marks PAID when the tenant-secret signature + amount match', async () => {
    order.findUnique.mockResolvedValue({ id: 'o1', businessId: 'biz-1', totalMinor: 5000, currency: 'INR' });
    bpa.findUnique.mockResolvedValue(BYO_ACCOUNT);
    razorpay.verifyWebhookSignatureWithSecret.mockReturnValue(true);
    order.updateMany.mockResolvedValue({ count: 1 });

    const res = mockRes();
    await razorpayWebhook(webhookReq({ notes: { orderId: 'o1' }, amount: 5000, currency: 'INR', id: 'pay_1' }), res);

    expect(razorpay.verifyWebhookSignatureWithSecret).toHaveBeenCalledWith(expect.objectContaining({ secret: 'whsek' }));
    expect(order.updateMany.mock.calls[0][0].data.paymentRef).toBe('pay_1');
    expect(clearCartOnPaidOrder).toHaveBeenCalledWith('o1');
    expect(res.body).toBe('OK');
  });

  test('rejects an invalid signature (wrong/forged tenant secret)', async () => {
    order.findUnique.mockResolvedValue({ id: 'o1', businessId: 'biz-1', totalMinor: 5000, currency: 'INR' });
    bpa.findUnique.mockResolvedValue(BYO_ACCOUNT);
    razorpay.verifyWebhookSignatureWithSecret.mockReturnValue(false);

    const res = mockRes();
    await razorpayWebhook(webhookReq({ notes: { orderId: 'o1' }, amount: 5000, currency: 'INR', id: 'pay_1' }), res);

    expect(res.statusCode).toBe(400);
    expect(order.updateMany).not.toHaveBeenCalled();
  });

  test('does NOT mark PAID when the captured amount mismatches the order', async () => {
    order.findUnique.mockResolvedValue({ id: 'o1', businessId: 'biz-1', totalMinor: 5000, currency: 'INR' });
    bpa.findUnique.mockResolvedValue(BYO_ACCOUNT);
    razorpay.verifyWebhookSignatureWithSecret.mockReturnValue(true);

    const res = mockRes();
    await razorpayWebhook(webhookReq({ notes: { orderId: 'o1' }, amount: 100, currency: 'INR', id: 'pay_1' }), res);

    expect(order.updateMany).not.toHaveBeenCalled();
    expect(res.body).toBe('OK'); // still ack so Razorpay stops retrying
  });
});
