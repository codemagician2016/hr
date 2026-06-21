const prisma = require('./prisma');
const {
  getPaddleSubscription,
  getPaddleTransaction,
  isPaddleConfigured,
} = require('./paddle');
const {
  syncBusinessSubscriptionFromPaddle,
} = require('./subscriptionBilling');
const {
  syncPendingDomainRegistrationPayment,
} = require('../../domains/domainService');

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

async function reconcileSubscriptionRow(subscription) {
  let changed = false;

  if (subscription.paddleTransactionId) {
    const transaction = await getPaddleTransaction(subscription.paddleTransactionId).catch((err) => {
      console.error('[paddle reconcile] transaction fetch failed:', subscription.paddleTransactionId, err?.message || err);
      return null;
    });

    const txStatus = lower(transaction?.status);
    if (txStatus === 'completed' && transaction?.subscription_id) {
      const paddleSubscription = await getPaddleSubscription(transaction.subscription_id).catch((err) => {
        console.error('[paddle reconcile] subscription fetch failed:', transaction.subscription_id, err?.message || err);
        return null;
      });
      if (paddleSubscription) {
        await syncBusinessSubscriptionFromPaddle({
          businessId: subscription.businessId,
          paddleSubscription,
          paddleTransactionId: transaction.id || subscription.paddleTransactionId,
          ...(transaction?.custom_data?.targetVertical ? { targetVertical: transaction.custom_data.targetVertical } : {}),
        });
        changed = true;
      }
    }
  }

  if (subscription.paddleSubscriptionId) {
    const paddleSubscription = await getPaddleSubscription(subscription.paddleSubscriptionId).catch((err) => {
      console.error('[paddle reconcile] subscription fetch failed:', subscription.paddleSubscriptionId, err?.message || err);
      return null;
    });
    if (paddleSubscription) {
      await syncBusinessSubscriptionFromPaddle({
        businessId: subscription.businessId,
        paddleSubscription,
        paddleTransactionId: subscription.paddleTransactionId || null,
      });
      changed = true;
    }
  }

  return changed;
}

async function reconcilePendingDomain(domain) {
  if (!domain?.registrarRef?.startsWith('PADDLE:')) return false;
  const transactionId = domain.registrarRef.replace(/^PADDLE:/, '');
  const result = await syncPendingDomainRegistrationPayment({
    prisma,
    businessId: domain.businessId,
    transactionId,
  }).catch((err) => {
    console.error('[paddle reconcile] domain payment sync failed:', domain.name, err?.message || err);
    return null;
  });
  return Boolean(result?.synced);
}

async function reconcilePaddleBilling({ subscriptionLimit = 50, domainLimit = 50 } = {}) {
  if (!isPaddleConfigured()) {
    return { skipped: true, reason: 'paddle_not_configured' };
  }

  const summary = {
    subscriptionsScanned: 0,
    subscriptionsChanged: 0,
    domainsScanned: 0,
    domainsChanged: 0,
  };

  const subscriptions = await prisma.subscription.findMany({
    where: {
      OR: [
        { paddleTransactionId: { not: null } },
        { paddleSubscriptionId: { not: null } },
      ],
    },
    orderBy: { updatedAt: 'asc' },
    take: subscriptionLimit,
  });
  summary.subscriptionsScanned = subscriptions.length;

  for (const subscription of subscriptions) {
    try {
      if (await reconcileSubscriptionRow(subscription)) summary.subscriptionsChanged += 1;
    } catch (err) {
      console.error('[paddle reconcile] subscription row failed:', subscription.businessId, err?.message || err);
    }
  }

  if (prisma.domain) {
    const domains = await prisma.domain.findMany({
      where: {
        OR: [
          { status: 'PENDING', registrarRef: { startsWith: 'PADDLE:' } },
          { renewalPaymentStatus: 'PENDING', renewalPaddleTransactionId: { not: null } },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: domainLimit,
    }).catch(() => []);
    summary.domainsScanned = domains.length;

    for (const domain of domains) {
      if (await reconcilePendingDomain(domain)) summary.domainsChanged += 1;
    }
  }

  if (prisma.paddleBillingSubscription) {
    const billingRows = await prisma.paddleBillingSubscription.findMany({
      where: { paddleSubscriptionId: { not: null } },
      orderBy: { updatedAt: 'asc' },
      take: subscriptionLimit,
    }).catch(() => []);
    summary.billingRowsScanned = billingRows.length;
    summary.billingRowsChanged = 0;

    for (const row of billingRows) {
      const paddleSubscription = await getPaddleSubscription(row.paddleSubscriptionId).catch((err) => {
        console.error('[paddle reconcile] billing subscription fetch failed:', row.paddleSubscriptionId, err?.message || err);
        return null;
      });
      if (!paddleSubscription) continue;
      try {
        const { dispatchPaddleWebhookPayload } = require('../controllers/paddle.controller');
        await dispatchPaddleWebhookPayload({
          event_id: `reconcile_${row.id}_${Date.now()}`,
          event_type: 'subscription.updated',
          occurred_at: paddleSubscription.updated_at || new Date().toISOString(),
          data: paddleSubscription,
        });
        summary.billingRowsChanged += 1;
      } catch (err) {
        console.error('[paddle reconcile] billing row sync failed:', row.id, err?.message || err);
      }
    }
  }

  return summary;
}

module.exports = {
  reconcilePaddleBilling,
  reconcilePendingDomain,
  reconcileSubscriptionRow,
};
