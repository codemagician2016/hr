// Regression for SUB-005 / PAY-004 (HIGH), updated for the BYO India model:
// the Razorpay buyer-success handler must verify the signature with the TENANT's
// own key secret, bind the signed Razorpay order to THIS local order, only
// confirm a PENDING order via a status-guarded update, and never re-fire
// side-effects on replay.

jest.mock('@prisma/client', () => {
  const order = { findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() };
  const businessPaymentAccount = { findUnique: jest.fn() };
  return {
    PrismaClient: jest.fn(() => ({ order, businessPaymentAccount })),
    __order: order,
    __bpa: businessPaymentAccount,
  };
});
jest.mock('../src/core/lib/crypto', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
}));
jest.mock('../src/core/lib/razorpayRoute', () => ({
  verifyPaymentSignatureWithSecret: jest.fn(() => true),
}));
jest.mock('../src/core/lib/stripeConnect', () => ({ isConfigured: () => false }));
jest.mock('../src/shop/controllers/order.controller', () => ({
  clearCartOnPaidOrder: jest.fn(() => Promise.resolve()),
  confirmSlotBookingForOrder: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/shop/controllers/storefrontLoyalty.controller', () => ({
  grantOnPaidOrder: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/core/lib/webhookDispatcher', () => ({ safeEmit: jest.fn() }));

const { __order: order, __bpa: bpa } = require('@prisma/client');
const { clearCartOnPaidOrder } = require('../src/shop/controllers/order.controller');
const razorpay = require('../src/core/lib/razorpayRoute');
const { razorpayCheckoutSuccess } = require('../src/core/controllers/payments.controller');

const BYO_ACCOUNT = {
  provider: 'RAZORPAY',
  metadata: { connectionModel: 'BYO_KEYS', keyId: 'rzp_test_x', keySecretEncrypted: 'enc:tenant_secret' },
};

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  bpa.findUnique.mockResolvedValue(BYO_ACCOUNT);
  razorpay.verifyPaymentSignatureWithSecret.mockReturnValue(true);
});

function body(overrides = {}) {
  return {
    razorpay_order_id: 'order_THIS',
    razorpay_payment_id: 'pay_123',
    razorpay_signature: 'sig',
    orderId: 'local-1',
    ...overrides,
  };
}

describe('razorpayCheckoutSuccess money-safety (BYO)', () => {
  test('confirms a matching PENDING order, verifying with the tenant key secret', async () => {
    order.findUnique.mockResolvedValue({ id: 'local-1', businessId: 'biz-1', paymentMethod: 'online', status: 'PENDING', paymentRef: 'order_THIS' });
    order.updateMany.mockResolvedValue({ count: 1 });

    const res = mockRes();
    await razorpayCheckoutSuccess({ body: body() }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Verified with the TENANT's decrypted secret, not a platform secret.
    expect(razorpay.verifyPaymentSignatureWithSecret).toHaveBeenCalledWith(expect.objectContaining({ secret: 'tenant_secret' }));
    const update = order.updateMany.mock.calls[0][0];
    expect(update.where).toMatchObject({ id: 'local-1', status: 'PENDING', paymentMethod: 'online' });
    expect(update.data.paymentRef).toBe('pay_123');
    expect(clearCartOnPaidOrder).toHaveBeenCalledWith('local-1');
  });

  test('rejects a signature minted for a DIFFERENT (e.g. cheaper) order', async () => {
    order.findUnique.mockResolvedValue({ id: 'local-1', businessId: 'biz-1', paymentMethod: 'online', status: 'PENDING', paymentRef: 'order_OTHER' });

    const res = mockRes();
    await razorpayCheckoutSuccess({ body: body({ razorpay_order_id: 'order_THIS' }) }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.reason).toBe('ORDER_PAYMENT_MISMATCH');
    expect(order.updateMany).not.toHaveBeenCalled();
  });

  test('replay against an already-processed order does not re-fire side-effects', async () => {
    order.findUnique.mockResolvedValue({ id: 'local-1', businessId: 'biz-1', paymentMethod: 'online', status: 'PAID', paymentRef: 'order_THIS' });
    order.updateMany.mockResolvedValue({ count: 0 });

    const res = mockRes();
    await razorpayCheckoutSuccess({ body: body() }, res);

    expect(res.body).toEqual({ ok: true, alreadyProcessed: true });
    expect(clearCartOnPaidOrder).not.toHaveBeenCalled();
  });

  test('invalid signature is rejected before any state change', async () => {
    razorpay.verifyPaymentSignatureWithSecret.mockReturnValueOnce(false);
    order.findUnique.mockResolvedValue({ id: 'local-1', businessId: 'biz-1', paymentMethod: 'online', status: 'PENDING', paymentRef: 'order_THIS' });

    const res = mockRes();
    await razorpayCheckoutSuccess({ body: body() }, res);

    expect(res.statusCode).toBe(400);
    expect(order.updateMany).not.toHaveBeenCalled();
  });

  test('rejects when the seller has not connected a BYO Razorpay account', async () => {
    bpa.findUnique.mockResolvedValue(null);
    order.findUnique.mockResolvedValue({ id: 'local-1', businessId: 'biz-1', paymentMethod: 'online', status: 'PENDING', paymentRef: 'order_THIS' });

    const res = mockRes();
    await razorpayCheckoutSuccess({ body: body() }, res);

    expect(res.statusCode).toBe(409);
    expect(order.updateMany).not.toHaveBeenCalled();
  });
});
