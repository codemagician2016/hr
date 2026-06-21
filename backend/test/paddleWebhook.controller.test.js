jest.mock('../src/core/lib/prisma', () => ({
  paddleWebhookEvent: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn(),
  },
  subscription: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  business: {
    updateMany: jest.fn(),
    findUnique: jest.fn(),
  },
  user: {
    findFirst: jest.fn(),
  },
}));

jest.mock('../src/core/lib/paddle', () => ({
  getPaddleSubscription: jest.fn(),
  getPaddleWebhookSecret: jest.fn(() => 'whsec_test'),
  verifyPaddleWebhookSignature: jest.fn(() => true),
}));

jest.mock('../src/core/lib/subscriptionBilling', () => ({
  ensureBusinessSubscription: jest.fn(),
  extractPrimaryPaddlePriceId: jest.fn((subscription) => subscription?.items?.[0]?.price?.id || null),
  findTierForPaddlePriceId: jest.fn(),
  getFreeTier: jest.fn(),
  syncBusinessSubscriptionFromPaddle: jest.fn(),
}));

jest.mock('../src/core/lib/notifications/budgetEngine', () => ({
  addOveragePurchaseOnce: jest.fn(),
  getCurrentCycle: jest.fn(() => '2026-06'),
}));

jest.mock('../src/core/lib/billingLedger', () => ({
  recordAdjustmentLedger: jest.fn(() => Promise.resolve(null)),
  recordPaymentAttemptFromTransaction: jest.fn(() => Promise.resolve(null)),
  upsertPurchaseFromPaddleTransaction: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('../src/core/utils/email', () => ({
  sendSubscriptionStartedEmail: jest.fn(() => Promise.resolve()),
  sendPaymentFailedEmail: jest.fn(() => Promise.resolve()),
  sendSubscriptionCancelledEmail: jest.fn(() => Promise.resolve()),
}));

jest.mock('../src/domains/domainService', () => ({
  completePaidDomainRegistration: jest.fn(),
  completePaidDomainRenewal: jest.fn(),
  isDomainRegistrationPayment: jest.fn(() => false),
  isDomainRenewalPayment: jest.fn(() => false),
  markDomainPaymentFailed: jest.fn(),
  handleDomainPaymentAdjustment: jest.fn(() => ({ handled: false })),
}));

const prisma = require('../src/core/lib/prisma');
const { getPaddleSubscription } = require('../src/core/lib/paddle');
const {
  ensureBusinessSubscription,
  findTierForPaddlePriceId,
  syncBusinessSubscriptionFromPaddle,
} = require('../src/core/lib/subscriptionBilling');
const { addOveragePurchaseOnce } = require('../src/core/lib/notifications/budgetEngine');
const {
  dispatchPaddleWebhookPayload,
  recordPaddleWebhookEvent,
} = require('../src/core/controllers/paddle.controller');

describe('Paddle webhook controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.business.updateMany.mockResolvedValue({ count: 0 });
    prisma.business.findUnique.mockResolvedValue({ name: 'Test Business' });
    prisma.user.findFirst.mockResolvedValue(null);
    ensureBusinessSubscription.mockResolvedValue({ businessId: 'biz_1' });
  });

  test('records duplicate event_id deliveries without requeueing processed events', async () => {
    const existing = {
      id: 'pwe_1',
      eventId: 'evt_1',
      eventType: 'transaction.completed',
      status: 'PROCESSED',
      updatedAt: new Date(),
    };
    prisma.paddleWebhookEvent.create.mockRejectedValue({ code: 'P2002' });
    prisma.paddleWebhookEvent.findUnique.mockResolvedValue(existing);

    const result = await recordPaddleWebhookEvent({
      event_id: 'evt_1',
      event_type: 'transaction.completed',
      occurred_at: '2026-06-03T00:00:00Z',
      data: {
        id: 'txn_1',
        custom_data: { businessId: 'biz_1' },
      },
    });

    expect(result).toEqual({ event: existing, duplicate: true, requeued: false });
    expect(prisma.paddleWebhookEvent.update).not.toHaveBeenCalled();
  });

  test('defers a paid subscription event until transaction.completed has processed', async () => {
    prisma.subscription.findFirst.mockResolvedValueOnce({ businessId: 'biz_1' });
    prisma.subscription.findUnique.mockResolvedValueOnce({
      status: 'ACTIVE',
      paddleSubscriptionId: null,
      paddleTransactionId: 'txn_pending',
      tier: { slug: 'free' },
    });
    findTierForPaddlePriceId.mockResolvedValue({
      tier: { id: 'tier_starter', slug: 'starter' },
    });
    prisma.paddleWebhookEvent.findFirst.mockResolvedValue(null);

    await dispatchPaddleWebhookPayload({
      event_type: 'subscription.updated',
      data: {
        id: 'sub_1',
        status: 'active',
        transaction_id: 'txn_pending',
        customer_id: 'ctm_1',
        items: [{ price: { id: 'pri_starter_monthly' } }],
      },
    });

    expect(syncBusinessSubscriptionFromPaddle).not.toHaveBeenCalled();
  });

  test('records localized currency mismatch but still syncs when price id matches', async () => {
    prisma.subscription.findUnique.mockResolvedValueOnce({ paddleTransactionId: null });
    getPaddleSubscription.mockResolvedValue({
      id: 'sub_1',
      status: 'active',
      customer_id: 'ctm_1',
      items: [{ price: { id: 'pri_starter_monthly' } }],
    });

    await expect(dispatchPaddleWebhookPayload({
      event_type: 'transaction.completed',
      data: {
        id: 'txn_1',
        status: 'completed',
        subscription_id: 'sub_1',
        customer_id: 'ctm_1',
        currency_code: 'EUR',
        custom_data: {
          businessId: 'biz_1',
          expectedCurrencyCode: 'USD',
          expectedPriceId: 'pri_starter_monthly',
        },
      },
    })).resolves.toBeUndefined();

    expect(syncBusinessSubscriptionFromPaddle).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'biz_1',
      paddleTransactionId: 'txn_1',
    }));
  });

  test('grants SMS top-up credit from transaction.completed only after amount reconciliation', async () => {
    addOveragePurchaseOnce.mockResolvedValue({ granted: true, grant: { id: 'grant_1' }, usage: null });

    await expect(dispatchPaddleWebhookPayload({
      event_id: 'evt_sms_1',
      event_type: 'transaction.completed',
      occurred_at: '2026-06-04T00:00:00Z',
      data: {
        id: 'txn_sms_5',
        status: 'completed',
        currency_code: 'USD',
        details: { totals: { grand_total: '500', discount: '0', currency_code: 'USD' } },
        custom_data: {
          kind: 'sms',
          productKind: 'SMS',
          checkoutKind: 'sms_topup',
          businessId: 'biz_1',
          amountUsd: 5,
          expectedCurrencyCode: 'USD',
          expectedAmountMinor: 500,
          cycle: '2026-06',
        },
      },
    })).resolves.toBeUndefined();

    expect(addOveragePurchaseOnce).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'biz_1',
      amountUsd: 5,
      cycle: '2026-06',
      paddleTransactionId: 'txn_sms_5',
    }));
    expect(ensureBusinessSubscription).not.toHaveBeenCalled();
    expect(syncBusinessSubscriptionFromPaddle).not.toHaveBeenCalled();
  });

  test('rejects discounted SMS top-up transactions so credit value cannot exceed settled payment', async () => {
    await expect(dispatchPaddleWebhookPayload({
      event_id: 'evt_sms_discount',
      event_type: 'transaction.completed',
      occurred_at: '2026-06-04T00:00:00Z',
      data: {
        id: 'txn_sms_discount',
        status: 'completed',
        currency_code: 'USD',
        details: { totals: { grand_total: '500', discount: '500', currency_code: 'USD' } },
        custom_data: {
          kind: 'sms',
          productKind: 'SMS',
          checkoutKind: 'sms_topup',
          businessId: 'biz_1',
          amountUsd: 5,
          expectedCurrencyCode: 'USD',
          expectedAmountMinor: 500,
          cycle: '2026-06',
        },
      },
    })).rejects.toMatchObject({ code: 'PADDLE_SMS_TOPUP_DISCOUNT_BLOCKED' });

    expect(addOveragePurchaseOnce).not.toHaveBeenCalled();
  });
});
