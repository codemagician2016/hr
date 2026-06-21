jest.mock('../src/core/lib/prisma', () => ({}));

jest.mock('../src/core/lib/paddle', () => ({
  cancelPaddleSubscription: jest.fn(),
  createPaddleCustomerPortalSession: jest.fn(),
  createPaddleCustomer: jest.fn(),
  createPaddleTransaction: jest.fn(),
  getPaddleEnvironment: jest.fn(() => 'sandbox'),
  getPaddleSubscription: jest.fn(),
  getPaddleTransaction: jest.fn(),
  getPaddleTransactionInvoice: jest.fn(),
  isPaddleConfigured: jest.fn(() => true),
  listPaddleClientTokens: jest.fn(),
  listPaddleSubscriptionsForCustomer: jest.fn(),
  listPaddleTransactions: jest.fn(),
  updatePaddleSubscription: jest.fn(),
}));

jest.mock('../src/core/lib/subscriptionBilling', () => ({
  FOREVER: jest.fn(() => new Date('2126-01-01T00:00:00Z')),
  FREE_TIER_SLUG: 'free',
  ensureBusinessSubscription: jest.fn(),
  getBusinessSubscription: jest.fn(),
  getPriceIdForBillingCycle: jest.fn(),
  hydrateSubscription: jest.fn((subscription) => subscription),
  normalizeCountryCode: jest.fn((country) => country || null),
  resolveTierPriceRecord: jest.fn(),
  syncBusinessSubscriptionFromPaddle: jest.fn(),
}));

jest.mock('../src/core/lib/paddleBillingViews', () => ({
  buildBillingContext: jest.fn(),
  extractAfterCursor: jest.fn(),
  invoiceAvailableForTransaction: jest.fn(),
  serializeBillingTransaction: jest.fn(),
}));
jest.mock('../src/core/lib/inbox', () => ({ listBusinessAdminRecipients: jest.fn() }));
jest.mock('../src/core/utils/email', () => ({ sendEmail: jest.fn() }));
jest.mock('../src/core/lib/launchPeriod', () => ({
  isLaunchFreePeriod: jest.fn(() => false),
  launchFreeUntil: jest.fn(() => null),
}));
jest.mock('../src/core/lib/vertical', () => ({ resolveVertical: jest.fn((v) => v || 'APPOINTMENT') }));

const {
  getPaddleSubscription,
  getPaddleTransaction,
  listPaddleSubscriptionsForCustomer,
} = require('../src/core/lib/paddle');
const {
  getBusinessSubscription,
  syncBusinessSubscriptionFromPaddle,
} = require('../src/core/lib/subscriptionBilling');
const { syncFromPaddle } = require('../src/core/controllers/subscription.controller');

function response() {
  return {
    statusCode: 200,
    body: null,
    status: jest.fn(function status(code) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn(function json(body) {
      this.body = body;
      return this;
    }),
  };
}

describe('syncFromPaddle ownership checks', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    require('../src/core/lib/paddle').isPaddleConfigured.mockReturnValue(true);
  });

  test('rejects a client-supplied transaction id that belongs to another business', async () => {
    getBusinessSubscription.mockResolvedValue({
      businessId: 'biz_1',
      paddleCustomerId: 'ctm_1',
      paddleTransactionId: 'txn_owned',
    });
    getPaddleTransaction.mockResolvedValue({
      id: 'txn_other',
      status: 'completed',
      customer_id: 'ctm_2',
      custom_data: { businessId: 'biz_2' },
      subscription_id: 'sub_other',
    });
    const res = response();

    await syncFromPaddle({
      user: { businessId: 'biz_1' },
      body: { transactionId: 'txn_other' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(getPaddleTransaction).toHaveBeenCalledWith('txn_other');
    expect(syncBusinessSubscriptionFromPaddle).not.toHaveBeenCalled();
  });

  test('syncs a returned owned transaction even when a newer pending transaction is stored', async () => {
    const existing = {
      businessId: 'biz_1',
      paddleCustomerId: 'ctm_1',
      paddleTransactionId: 'txn_newer_pending',
    };
    const paddleSubscription = {
      id: 'sub_old',
      status: 'active',
      customer_id: 'ctm_1',
      custom_data: { businessId: 'biz_1' },
    };
    getBusinessSubscription.mockResolvedValue(existing);
    getPaddleTransaction.mockResolvedValue({
      id: 'txn_returned',
      status: 'completed',
      customer_id: 'ctm_1',
      custom_data: { businessId: 'biz_1' },
      subscription_id: 'sub_old',
    });
    getPaddleSubscription.mockResolvedValue(paddleSubscription);
    syncBusinessSubscriptionFromPaddle.mockResolvedValue({ id: 'local_sub_returned' });
    const res = response();

    await syncFromPaddle({
      user: { businessId: 'biz_1' },
      body: { transactionId: 'txn_returned' },
    }, res);

    expect(syncBusinessSubscriptionFromPaddle).toHaveBeenCalledWith({
      businessId: 'biz_1',
      paddleSubscription,
      paddleTransactionId: 'txn_returned',
      paddleEventOccurredAt: null,
    });
    expect(res.body).toEqual({ synced: true, subscription: { id: 'local_sub_returned' } });
  });

  test('does not sync an owned transaction until Paddle marks it completed', async () => {
    const existing = {
      businessId: 'biz_1',
      paddleCustomerId: 'ctm_1',
      paddleTransactionId: 'txn_owned',
    };
    getBusinessSubscription.mockResolvedValue(existing);
    getPaddleTransaction.mockResolvedValue({
      id: 'txn_owned',
      status: 'billed',
      customer_id: 'ctm_1',
      custom_data: { businessId: 'biz_1' },
      subscription_id: 'sub_1',
    });
    const res = response();

    await syncFromPaddle({
      user: { businessId: 'biz_1' },
      body: {},
    }, res);

    expect(res.body).toEqual(expect.objectContaining({ synced: false }));
    expect(getPaddleSubscription).not.toHaveBeenCalled();
    expect(syncBusinessSubscriptionFromPaddle).not.toHaveBeenCalled();
  });

  test('rejects a completed transaction owned by another Paddle customer', async () => {
    const existing = {
      businessId: 'biz_1',
      paddleCustomerId: 'ctm_1',
      paddleTransactionId: 'txn_owned',
    };
    getBusinessSubscription.mockResolvedValue(existing);
    getPaddleTransaction.mockResolvedValue({
      id: 'txn_owned',
      status: 'completed',
      customer_id: 'ctm_2',
      custom_data: { businessId: 'biz_1' },
      subscription_id: 'sub_2',
    });
    const res = response();

    await syncFromPaddle({
      user: { businessId: 'biz_1' },
      body: {},
    }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(getPaddleSubscription).not.toHaveBeenCalled();
    expect(syncBusinessSubscriptionFromPaddle).not.toHaveBeenCalled();
  });

  test('syncs an owned completed transaction and matching subscription', async () => {
    const existing = {
      businessId: 'biz_1',
      paddleCustomerId: 'ctm_1',
      paddleTransactionId: 'txn_owned',
    };
    const paddleSubscription = {
      id: 'sub_1',
      status: 'active',
      customer_id: 'ctm_1',
      custom_data: { businessId: 'biz_1' },
    };
    getBusinessSubscription.mockResolvedValue(existing);
    getPaddleTransaction.mockResolvedValue({
      id: 'txn_owned',
      status: 'completed',
      customer_id: 'ctm_1',
      custom_data: { businessId: 'biz_1' },
      subscription_id: 'sub_1',
    });
    getPaddleSubscription.mockResolvedValue(paddleSubscription);
    syncBusinessSubscriptionFromPaddle.mockResolvedValue({ id: 'local_sub_1' });
    const res = response();

    await syncFromPaddle({
      user: { businessId: 'biz_1' },
      body: {},
    }, res);

    expect(syncBusinessSubscriptionFromPaddle).toHaveBeenCalledWith({
      businessId: 'biz_1',
      paddleSubscription,
      paddleTransactionId: 'txn_owned',
      paddleEventOccurredAt: null,
    });
    expect(res.body).toEqual({ synced: true, subscription: { id: 'local_sub_1' } });
  });

  test('rejects customer fallback subscriptions that do not match the business customer', async () => {
    const existing = {
      businessId: 'biz_1',
      paddleCustomerId: 'ctm_1',
      paddleTransactionId: null,
    };
    getBusinessSubscription.mockResolvedValue(existing);
    listPaddleSubscriptionsForCustomer.mockResolvedValue([{
      id: 'sub_other',
      status: 'active',
      customer_id: 'ctm_2',
      updated_at: '2026-06-01T00:00:00Z',
    }]);
    const res = response();

    await syncFromPaddle({
      user: { businessId: 'biz_1' },
      body: {},
    }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(syncBusinessSubscriptionFromPaddle).not.toHaveBeenCalled();
  });
});
