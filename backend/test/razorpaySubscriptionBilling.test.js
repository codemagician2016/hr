// Razorpay SaaS-subscription billing: charge/refund recording + the pull-based
// activation backstop. These cover the money paths added for the math16/ecom6
// onboarding fixes (gateway-agnostic payment history + reconcile-when-stuck).

const mockPrisma = {
  paymentAttempt: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  subscription: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  user: { findFirst: jest.fn() },
  business: { findUnique: jest.fn() },
  razorpayWebhookEvent: {},
};
const mockSync = jest.fn();
const mockLedger = { recordGatewayPayment: jest.fn() };

jest.mock('../src/core/lib/prisma', () => mockPrisma);
jest.mock('../src/core/lib/subscriptionBilling', () => ({
  syncBusinessSubscriptionFromRazorpay: mockSync,
  FREE_TIER_SLUGS: new Set(['free', 'static-free', 'ecom-free']),
}));
jest.mock('../src/core/lib/billingLedger', () => mockLedger);
jest.mock('../src/core/utils/email', () => ({
  sendSubscriptionStartedEmail: jest.fn(),
  sendPaymentFailedEmail: jest.fn(),
  sendSubscriptionCancelledEmail: jest.fn(),
}));

const { dispatchRazorpayEvent, reconcileStuckRazorpaySubscriptions } = require('../src/core/controllers/razorpay.controller');
const { RazorpayGateway } = require('../src/core/lib/billing/gateways/razorpayGateway');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RAZORPAY_KEY_ID = 'rzp_test_x';
  process.env.RAZORPAY_KEY_SECRET = 'secret_x';
  mockPrisma.subscription.findUnique.mockResolvedValue({ status: 'TRIALING' });
  mockPrisma.subscription.findFirst.mockResolvedValue(null);
  mockPrisma.user.findFirst.mockResolvedValue(null); // no admin → email no-ops
  mockSync.mockResolvedValue({});
  mockLedger.recordGatewayPayment.mockResolvedValue({ id: 'pa' }); // returns a promise (.catch in controller)
});

function chargeEvent(overrides = {}) {
  return {
    event: 'subscription.charged',
    created_at: 1700000000,
    payload: {
      subscription: { entity: { id: 'sub_1', status: 'active', plan_id: 'plan_1', notes: { businessId: 'biz1' }, current_end: 1700001000 } },
      payment: { entity: { id: 'pay_1', amount: 119900, currency: 'INR' } },
    },
    ...overrides,
  };
}

describe('dispatchRazorpayEvent — charge/refund recording', () => {
  test('records a COMPLETED payment on subscription.charged', async () => {
    await dispatchRazorpayEvent(chargeEvent());
    expect(mockSync).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz1' }));
    expect(mockLedger.recordGatewayPayment).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'biz1',
      provider: 'razorpay',
      gatewayTransactionId: 'pay_1',
      amountMinor: 119900,
      currencyCode: 'INR',
      status: 'COMPLETED',
    }));
  });

  test('does NOT record a charge on subscription.activated even if a payment entity is present', async () => {
    const activated = chargeEvent({
      event: 'subscription.activated',
      payload: {
        subscription: { entity: { id: 'sub_1', status: 'active', plan_id: 'plan_1', notes: { businessId: 'biz1' }, current_end: 1700001000 } },
        payment: { entity: { id: 'pay_x', amount: 119900, currency: 'INR' } },
      },
    });
    await dispatchRazorpayEvent(activated);
    expect(mockSync).toHaveBeenCalled(); // still syncs entitlement
    expect(mockLedger.recordGatewayPayment).not.toHaveBeenCalled(); // but no phantom charge
  });

  function refundEvent(refundId, amount = 5000) {
    return {
      event: 'refund.created',
      created_at: 1700000500,
      payload: { refund: { entity: { id: refundId, payment_id: 'pay_1', amount, currency: 'INR', notes: { businessId: 'biz1' } } } },
    };
  }

  test('records a REFUNDED row keyed on the REFUND id (not the payment id), with payment id in metadata', async () => {
    await dispatchRazorpayEvent(refundEvent('rfnd_1'));
    expect(mockLedger.recordGatewayPayment).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'biz1',
      provider: 'razorpay',
      gatewayTransactionId: 'rfnd_1',
      amountMinor: 5000,
      status: 'REFUNDED',
      metadata: expect.objectContaining({ paymentId: 'pay_1' }),
    }));
  });

  test('two partial refunds of the same payment become DISTINCT rows (keyed on refund id)', async () => {
    await dispatchRazorpayEvent(refundEvent('rfnd_1', 5000));
    await dispatchRazorpayEvent(refundEvent('rfnd_2', 3000));
    const keys = mockLedger.recordGatewayPayment.mock.calls.map((c) => c[0].gatewayTransactionId);
    expect(keys).toEqual(['rfnd_1', 'rfnd_2']); // not collapsed onto 'pay_1'
  });

  test('a ledger write failure never throws out of dispatch', async () => {
    mockLedger.recordGatewayPayment.mockRejectedValueOnce(new Error('db down'));
    await expect(dispatchRazorpayEvent(chargeEvent())).resolves.toBeUndefined();
    expect(mockSync).toHaveBeenCalled(); // entitlement sync still happened
  });
});

describe('reconcileStuckRazorpaySubscriptions — pull-based activation backstop', () => {
  test('pulls live state for stuck subs (non-ACTIVE, or ACTIVE-on-free) and syncs them', async () => {
    mockPrisma.subscription.findMany.mockResolvedValue([
      { businessId: 'biz1', razorpaySubscriptionId: 'sub_1', status: 'TRIALING', tier: { slug: 'static-business' } },
      { businessId: 'biz2', razorpaySubscriptionId: 'sub_2', status: 'ACTIVE', tier: { slug: 'ecom-free' } }, // ACTIVE but on a FREE tier → stuck
    ]);
    const getSub = jest.spyOn(RazorpayGateway.prototype, 'getSubscription')
      .mockImplementation(async (id) => ({ id, status: 'active', plan_id: 'plan_1', notes: { businessId: id === 'sub_1' ? 'biz1' : 'biz2' }, current_end: 1700001000 }));

    const summary = await reconcileStuckRazorpaySubscriptions({ limit: 25 });

    expect(summary).toEqual({ scanned: 2, reconciled: 2 });
    expect(getSub).toHaveBeenCalledTimes(2);
    expect(mockSync).toHaveBeenCalledTimes(2);
    getSub.mockRestore();
  });

  test('NEVER re-pulls an ACTIVE sub already on a PAID tier (no transient-downgrade risk)', async () => {
    mockPrisma.subscription.findMany.mockResolvedValue([
      { businessId: 'biz1', razorpaySubscriptionId: 'sub_1', status: 'ACTIVE', tier: { slug: 'static-business' } }, // healthy paid
    ]);
    const getSub = jest.spyOn(RazorpayGateway.prototype, 'getSubscription').mockResolvedValue({ id: 'sub_1', status: 'active' });

    const summary = await reconcileStuckRazorpaySubscriptions();

    expect(summary).toEqual({ scanned: 0, reconciled: 0 });
    expect(getSub).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
    getSub.mockRestore();
  });

  test("skips a sub whose live status doesn't entitle (e.g. 'created') without syncing", async () => {
    mockPrisma.subscription.findMany.mockResolvedValue([{ businessId: 'biz1', razorpaySubscriptionId: 'sub_1', status: 'TRIALING', tier: { slug: 'static-business' } }]);
    const getSub = jest.spyOn(RazorpayGateway.prototype, 'getSubscription')
      .mockResolvedValue({ id: 'sub_1', status: 'created', plan_id: 'plan_1', notes: { businessId: 'biz1' } });

    const summary = await reconcileStuckRazorpaySubscriptions();

    expect(summary).toEqual({ scanned: 1, reconciled: 0 });
    expect(mockSync).not.toHaveBeenCalled();
    getSub.mockRestore();
  });

  test('one tenant failing does not abort the batch', async () => {
    mockPrisma.subscription.findMany.mockResolvedValue([
      { businessId: 'biz1', razorpaySubscriptionId: 'sub_1', status: 'TRIALING', tier: { slug: 'static-business' } },
      { businessId: 'biz2', razorpaySubscriptionId: 'sub_2', status: 'TRIALING', tier: { slug: 'static-business' } },
    ]);
    const getSub = jest.spyOn(RazorpayGateway.prototype, 'getSubscription')
      .mockImplementation(async (id) => {
        if (id === 'sub_1') throw new Error('razorpay 500');
        return { id, status: 'active', plan_id: 'plan_1', notes: { businessId: 'biz2' }, current_end: 1700001000 };
      });

    const summary = await reconcileStuckRazorpaySubscriptions();

    expect(summary).toEqual({ scanned: 2, reconciled: 1 });
    expect(mockSync).toHaveBeenCalledTimes(1);
    getSub.mockRestore();
  });
});
