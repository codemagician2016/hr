// Stripe subscription webhook dispatch — B5 (charge/refund recording) + B10
// (failed-charge recording). Uses the REAL stripeGateway.normalizeEvent so the
// 2025-03-31.basil event shapes are exercised; mocks prisma/sync/ledger/email.

const mockPrisma = {
  subscription: { findUnique: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
  user: { findFirst: jest.fn() },
  business: { findUnique: jest.fn() },
};
const mockSync = jest.fn();
const mockLedger = { recordGatewayPayment: jest.fn() };

jest.mock('../src/core/lib/prisma', () => mockPrisma);
jest.mock('../src/core/lib/subscriptionBilling', () => ({ syncBusinessSubscriptionFromStripe: mockSync }));
jest.mock('../src/core/lib/billingLedger', () => mockLedger);
jest.mock('../src/core/utils/email', () => ({
  sendSubscriptionStartedEmail: jest.fn(),
  sendPaymentFailedEmail: jest.fn(),
  sendSubscriptionCancelledEmail: jest.fn(),
}));

const { dispatchStripeEvent } = require('../src/core/controllers/stripe.controller');
const { StripeGateway } = require('../src/core/lib/billing/gateways/stripeGateway');

beforeEach(() => {
  jest.clearAllMocks();
  // resolveBusinessId: event metadata carries businessId; no conflicting mapping.
  mockPrisma.subscription.findFirst.mockResolvedValue(null);
  mockPrisma.subscription.findUnique.mockResolvedValue({ status: 'ACTIVE' });
  mockPrisma.subscription.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.user.findFirst.mockResolvedValue(null);
  mockLedger.recordGatewayPayment.mockResolvedValue({ id: 'pa' });
  mockSync.mockResolvedValue({});
});

const META = { businessId: 'biz1' };

describe('Stripe charge / refund / failed recording', () => {
  test('invoice.paid → records a COMPLETED stripe payment (B5)', async () => {
    await dispatchStripeEvent({
      type: 'invoice.paid', id: 'evt_1',
      data: { object: { customer: 'cus_1', charge: 'ch_1', amount_paid: 4900, currency: 'nzd', parent: { subscription_details: { subscription: 'sub_1', metadata: META } } } },
    });
    expect(mockLedger.recordGatewayPayment).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'biz1', provider: 'stripe', gatewayTransactionId: 'ch_1', amountMinor: 4900, currencyCode: 'NZD', status: 'COMPLETED',
    }));
  });

  test('invoice.paid with amount_paid 0 (trial) → does NOT record a $0 row', async () => {
    await dispatchStripeEvent({
      type: 'invoice.paid', id: 'evt_2',
      data: { object: { customer: 'cus_1', charge: 'ch_0', amount_paid: 0, currency: 'nzd', parent: { subscription_details: { subscription: 'sub_1', metadata: META } } } },
    });
    expect(mockLedger.recordGatewayPayment).not.toHaveBeenCalled();
  });

  test('charge.refunded → records a REFUNDED row (B5)', async () => {
    await dispatchStripeEvent({
      type: 'charge.refunded', id: 'evt_3',
      data: { object: { customer: 'cus_1', payment_intent: 'pi_1', amount_refunded: 4900, currency: 'nzd', metadata: META } },
    });
    expect(mockLedger.recordGatewayPayment).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'stripe', gatewayTransactionId: 'pi_1', status: 'REFUNDED',
    }));
  });

  test('invoice.payment_failed → records a FAILED row + does not throw (B10)', async () => {
    await dispatchStripeEvent({
      type: 'invoice.payment_failed', id: 'evt_4',
      data: { object: { customer: 'cus_1', id: 'in_1', amount_due: 4900, currency: 'nzd', parent: { subscription_details: { subscription: 'sub_1', metadata: META } } } },
    });
    expect(mockLedger.recordGatewayPayment).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'stripe', gatewayTransactionId: 'in_1', status: 'FAILED',
    }));
  });

  test('checkout.session.completed only stamps the sub id — does NOT record a charge (no double rows)', async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue({ stripeSubscriptionId: null });
    await dispatchStripeEvent({
      type: 'checkout.session.completed', id: 'evt_5',
      data: { object: { id: 'cs_1', customer: 'cus_1', subscription: 'sub_1', amount_total: 4900, currency: 'nzd', metadata: META } },
    });
    expect(mockPrisma.subscription.updateMany).toHaveBeenCalled();
    expect(mockLedger.recordGatewayPayment).not.toHaveBeenCalled();
  });
});

describe('B9 — duplicate-subscription guard on checkout.session.completed', () => {
  test('a second, DIFFERENT subscription is cancelled and the original is kept', async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue({ stripeSubscriptionId: 'sub_original' });
    const cancel = jest.spyOn(StripeGateway.prototype, 'cancelSubscription').mockResolvedValue({});
    await dispatchStripeEvent({
      type: 'checkout.session.completed', id: 'evt_dup',
      data: { object: { id: 'cs_2', customer: 'cus_1', subscription: 'sub_duplicate', metadata: META } },
    });
    expect(cancel).toHaveBeenCalledWith('sub_duplicate', { immediately: true });
    expect(mockPrisma.subscription.updateMany).not.toHaveBeenCalled(); // original id NOT overwritten
    cancel.mockRestore();
  });

  test('the same subscription id arriving again just stamps it (no cancel)', async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue({ stripeSubscriptionId: 'sub_1' });
    const cancel = jest.spyOn(StripeGateway.prototype, 'cancelSubscription').mockResolvedValue({});
    await dispatchStripeEvent({
      type: 'checkout.session.completed', id: 'evt_same',
      data: { object: { id: 'cs_3', customer: 'cus_1', subscription: 'sub_1', metadata: META } },
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(mockPrisma.subscription.updateMany).toHaveBeenCalled();
    cancel.mockRestore();
  });
});
