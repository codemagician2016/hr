// recordGatewayPayment — gateway-neutral payment recorder (Razorpay/Stripe).
// Idempotent via a DB upsert on the @@unique([businessId, paddleTransactionId,
// status]) key (B18), so a webhook retry / reconcile / redelivery never
// duplicates a payment-history row.

const mockPrisma = {
  paymentAttempt: { upsert: jest.fn() },
  billingPurchase: {},
};
jest.mock('../src/core/lib/prisma', () => mockPrisma);

const { recordGatewayPayment } = require('../src/core/lib/billingLedger');

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.paymentAttempt.upsert.mockResolvedValue({ id: 'pa1' });
});

describe('recordGatewayPayment', () => {
  test('upserts keyed on (businessId, txn id, status); provider lowercased, metadata tagged', async () => {
    await recordGatewayPayment({
      businessId: 'biz1', provider: 'RAZORPAY', gatewayTransactionId: 'pay_1',
      amountMinor: 119900, currencyCode: 'inr', status: 'COMPLETED',
    });
    expect(mockPrisma.paymentAttempt.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { businessId_paddleTransactionId_status: { businessId: 'biz1', paddleTransactionId: 'pay_1', status: 'COMPLETED' } },
      update: expect.objectContaining({ amountMinor: 119900, currencyCode: 'INR', metadata: expect.objectContaining({ gateway: 'RAZORPAY', gatewayTransactionId: 'pay_1' }) }),
      create: expect.objectContaining({ businessId: 'biz1', provider: 'razorpay', paddleTransactionId: 'pay_1', status: 'COMPLETED', amountMinor: 119900 }),
    }));
  });

  test('a retry of the same charge upserts the SAME key (DB unique prevents a dup row)', async () => {
    await recordGatewayPayment({ businessId: 'biz1', provider: 'razorpay', gatewayTransactionId: 'pay_1', amountMinor: 119900, currencyCode: 'INR', status: 'COMPLETED' });
    await recordGatewayPayment({ businessId: 'biz1', provider: 'razorpay', gatewayTransactionId: 'pay_1', amountMinor: 119900, currencyCode: 'INR', status: 'COMPLETED' });
    const keys = mockPrisma.paymentAttempt.upsert.mock.calls.map((c) => c[0].where.businessId_paddleTransactionId_status);
    expect(keys[0]).toEqual(keys[1]); // same upsert key → at most one row
  });

  test('a refund (REFUNDED) is a DISTINCT key from the COMPLETED charge of the same payment id', async () => {
    await recordGatewayPayment({ businessId: 'biz1', provider: 'razorpay', gatewayTransactionId: 'pay_1', amountMinor: 5000, currencyCode: 'INR', status: 'REFUNDED' });
    expect(mockPrisma.paymentAttempt.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { businessId_paddleTransactionId_status: { businessId: 'biz1', paddleTransactionId: 'pay_1', status: 'REFUNDED' } },
    }));
  });

  test('returns null (no write) when a required field is missing (incl. provider — B15)', async () => {
    expect(await recordGatewayPayment({ businessId: 'biz1', provider: 'razorpay' })).toBeNull(); // no txn id
    expect(await recordGatewayPayment({ provider: 'razorpay', gatewayTransactionId: 'pay_1' })).toBeNull(); // no businessId
    expect(await recordGatewayPayment({ businessId: 'biz1', gatewayTransactionId: 'pay_1' })).toBeNull(); // no provider
    expect(mockPrisma.paymentAttempt.upsert).not.toHaveBeenCalled();
  });
});
