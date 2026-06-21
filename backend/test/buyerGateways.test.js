const mockRazorpay = { createOrderWithKeys: jest.fn(), refundPayment: jest.fn() };
const mockStripe = { createPaymentIntentWithKey: jest.fn(), createDirectCharge: jest.fn(), refundWithKey: jest.fn(), refundDirectCharge: jest.fn() };
jest.mock('../src/core/lib/razorpayRoute', () => mockRazorpay);
jest.mock('../src/core/lib/stripeConnect', () => mockStripe);
jest.mock('../src/core/lib/crypto', () => ({ decrypt: (v) => `dec(${v})`, encrypt: (v) => `enc(${v})` }));

const { getBuyerGateway } = require('../src/core/lib/billing/buyerGateways');

const order = { id: 'order_123456789012', totalMinor: 5000, currency: 'INR', businessId: 'biz1' };
beforeEach(() => jest.clearAllMocks());

describe('buyer-gateway registry', () => {
  test('maps providers; null for unknown', () => {
    expect(getBuyerGateway('RAZORPAY').provider).toBe('RAZORPAY');
    expect(getBuyerGateway('stripe').provider).toBe('STRIPE');
    expect(getBuyerGateway('paypal')).toBeNull();
  });
});

describe('razorpay adapter', () => {
  const byo = { provider: 'RAZORPAY', accountId: 'rzp_test_x', metadata: { connectionModel: 'BYO_KEYS', keyId: 'rzp_test_x', keySecretEncrypted: 'enc' } };
  test('createOrder (BYO) builds the order on the tenant key', async () => {
    mockRazorpay.createOrderWithKeys.mockResolvedValue({ ok: true, orderId: 'order_rzp', amount: 5000, currency: 'INR' });
    const r = await getBuyerGateway('RAZORPAY').createOrder({ account: byo, order });
    expect(r.ok).toBe(true);
    expect(r.paymentRef).toBe('order_rzp');
    expect(r.checkout).toEqual({ provider: 'RAZORPAY', orderId: 'order_rzp', amount: 5000, currency: 'INR', keyId: 'rzp_test_x' });
    expect(mockRazorpay.createOrderWithKeys).toHaveBeenCalledWith(expect.objectContaining({ keyId: 'rzp_test_x', keySecret: 'dec(enc)', amountMinor: 5000 }));
  });
  test('createOrder rejects a non-BYO account (409)', async () => {
    const r = await getBuyerGateway('RAZORPAY').createOrder({ account: { provider: 'RAZORPAY', metadata: {} }, order });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(mockRazorpay.createOrderWithKeys).not.toHaveBeenCalled();
  });
  test('refund passes sub-merchant only for acc_ accounts', async () => {
    mockRazorpay.refundPayment.mockResolvedValue({ ok: true, refundId: 'rfnd' });
    await getBuyerGateway('RAZORPAY').refund({ account: { accountId: 'acc_1' }, paymentRef: 'pay_1', amountMinor: 100 });
    expect(mockRazorpay.refundPayment).toHaveBeenCalledWith({ paymentId: 'pay_1', amountMinor: 100, subMerchantAccountId: 'acc_1' });
    await getBuyerGateway('RAZORPAY').refund({ account: { accountId: 'rzp_test_x' }, paymentRef: 'pay_2', amountMinor: 100 });
    expect(mockRazorpay.refundPayment).toHaveBeenLastCalledWith({ paymentId: 'pay_2', amountMinor: 100, subMerchantAccountId: null });
  });
});

describe('stripe adapter', () => {
  const byo = { provider: 'STRIPE', accountId: 'pk_test_x', metadata: { connectionModel: 'BYO_KEYS', publishableKey: 'pk_test_x', secretKeyEncrypted: 'senc' } };
  const connect = { provider: 'STRIPE', accountId: 'acct_1', platformFeePct: 1.5, metadata: {} };
  const sOrder = { ...order, currency: 'usd' };
  test('createOrder (BYO) uses tenant key + returns the TENANT publishable key', async () => {
    mockStripe.createPaymentIntentWithKey.mockResolvedValue({ ok: true, clientSecret: 'cs', paymentIntentId: 'pi_1' });
    const r = await getBuyerGateway('STRIPE').createOrder({ account: byo, order: sOrder });
    expect(r.checkout).toEqual({ provider: 'STRIPE', mode: 'BYO', clientSecret: 'cs', paymentIntentId: 'pi_1', publishableKey: 'pk_test_x' });
    expect(mockStripe.createPaymentIntentWithKey).toHaveBeenCalledWith(expect.objectContaining({ secretKey: 'dec(senc)' }));
    expect(mockStripe.createDirectCharge).not.toHaveBeenCalled();
  });
  test('createOrder (Connect) uses direct charge + the PLATFORM publishable key', async () => {
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_platform';
    mockStripe.createDirectCharge.mockResolvedValue({ ok: true, clientSecret: 'cs2', paymentIntentId: 'pi_2' });
    const r = await getBuyerGateway('STRIPE').createOrder({ account: connect, order: sOrder });
    expect(r.checkout).toMatchObject({ provider: 'STRIPE', mode: 'CONNECT', paymentIntentId: 'pi_2', publishableKey: 'pk_platform', connectedAccountId: 'acct_1' });
    expect(mockStripe.createPaymentIntentWithKey).not.toHaveBeenCalled();
  });
  test('refund: BYO uses tenant key, Connect uses connected account', async () => {
    mockStripe.refundWithKey.mockResolvedValue({ ok: true, refundId: 'r1' });
    await getBuyerGateway('STRIPE').refund({ account: byo, paymentRef: 'pi_1', amountMinor: 100 });
    expect(mockStripe.refundWithKey).toHaveBeenCalledWith({ secretKey: 'dec(senc)', paymentIntentId: 'pi_1', amountMinor: 100 });
    mockStripe.refundDirectCharge.mockResolvedValue({ ok: true, refundId: 'r2' });
    await getBuyerGateway('STRIPE').refund({ account: connect, paymentRef: 'pi_2', amountMinor: 100 });
    expect(mockStripe.refundDirectCharge).toHaveBeenCalledWith({ paymentIntentId: 'pi_2', amountMinor: 100, connectedAccountId: 'acct_1' });
  });
});
