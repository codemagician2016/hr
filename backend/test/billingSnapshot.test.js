// loadBusinessBillingSnapshot — Payment-history + renewal-date source. Verifies
// the gateway-agnostic surfacing (B5/B8/H1): non-Paddle gateways read the local
// PaymentAttempt ledger; the Paddle path stays Paddle-sourced; the source is
// chosen by the ACTIVE gateway, not by a sticky paddleCustomerId.

const mockPrisma = {
  paymentAttempt: { findMany: jest.fn() },
  subscription: {}, business: {}, pricingTier: {}, tierPrice: {},
};
jest.mock('../src/core/lib/prisma', () => mockPrisma);

const mockPaddleViews = {
  buildBillingContext: jest.fn(async () => ({})),
  serializeBillingTransaction: jest.fn((t) => ({ id: t.id, status: 'COMPLETED', business: null })),
  extractAfterCursor: jest.fn(() => null),
  invoiceAvailableForTransaction: jest.fn(() => false),
  toMinorInt: (v) => (v == null ? null : Number(v)),
};
jest.mock('../src/core/lib/paddleBillingViews', () => mockPaddleViews);
const mockPaddle = {
  listPaddleTransactions: jest.fn(),
  getPaddleSubscription: jest.fn(async () => null),
  isPaddleConfigured: () => true,
  getPaddleEnvironment: () => 'sandbox',
};
jest.mock('../src/core/lib/paddle', () => mockPaddle);

const { loadBusinessBillingSnapshot } = require('../src/core/controllers/subscription.controller');

const FUTURE = new Date('2026-07-10T00:00:00Z');
const PAID = { name: 'Professional', slug: 'professional' };

beforeEach(() => {
  jest.clearAllMocks();
  mockPaddle.listPaddleTransactions.mockResolvedValue({ data: [], meta: {} });
});

describe('non-Paddle gateways surface local ledger rows (B5/B8)', () => {
  test('Razorpay sub → maps PaymentAttempt rows to the UI transaction shape; nextBilledAt from currentPeriodEnd', async () => {
    mockPrisma.paymentAttempt.findMany.mockResolvedValue([
      { id: 'pa1', status: 'COMPLETED', amountMinor: 119900, currencyCode: 'INR', createdAt: new Date('2026-06-09T10:00:00Z') },
    ]);
    const sub = { businessId: 'biz1', gateway: 'RAZORPAY', razorpaySubscriptionId: 'sub_1', tier: PAID, billingCycle: 'MONTHLY', status: 'ACTIVE', currentPeriodEnd: FUTURE, paddleCustomerId: null };
    const snap = await loadBusinessBillingSnapshot(sub);
    expect(snap.transactions).toHaveLength(1);
    expect(snap.transactions[0]).toMatchObject({ id: 'pa1', status: 'COMPLETED', totalMinor: 119900, currencyCode: 'INR', plan: { name: 'Professional' } });
    expect(snap.transactions[0].paidAt).toBeTruthy();
    expect(snap.overview.nextBilledAt).toBeTruthy(); // from currentPeriodEnd
    expect(mockPaddle.listPaddleTransactions).not.toHaveBeenCalled();
    expect(mockPrisma.paymentAttempt.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { businessId: 'biz1', provider: { not: 'paddle' } },
    }));
  });

  test('B8: a tenant with a STALE paddleCustomerId but active Razorpay gateway STILL reads local rows', async () => {
    mockPrisma.paymentAttempt.findMany.mockResolvedValue([
      { id: 'pa2', status: 'COMPLETED', amountMinor: 50000, currencyCode: 'INR', createdAt: new Date('2026-06-08T00:00:00Z') },
    ]);
    const sub = { businessId: 'biz1', gateway: 'RAZORPAY', razorpaySubscriptionId: 'sub_1', tier: PAID, billingCycle: 'MONTHLY', status: 'ACTIVE', currentPeriodEnd: FUTURE, paddleCustomerId: 'cus_legacy' };
    const snap = await loadBusinessBillingSnapshot(sub);
    expect(snap.transactions).toHaveLength(1);
    expect(snap.transactions[0].id).toBe('pa2');
    expect(mockPaddle.listPaddleTransactions).not.toHaveBeenCalled(); // not the Paddle path
  });
});

describe('Paddle path unchanged', () => {
  test('a Paddle sub with a paddleCustomerId reads Paddle transactions, not local rows', async () => {
    const sub = { businessId: 'biz1', gateway: 'PADDLE', paddleCustomerId: 'cus_1', tier: PAID, billingCycle: 'MONTHLY', status: 'ACTIVE', currentPeriodEnd: FUTURE };
    await loadBusinessBillingSnapshot(sub);
    expect(mockPaddle.listPaddleTransactions).toHaveBeenCalledWith(expect.objectContaining({ customer_id: 'cus_1' }));
    expect(mockPrisma.paymentAttempt.findMany).not.toHaveBeenCalled();
  });
});
