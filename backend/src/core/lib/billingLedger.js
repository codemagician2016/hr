const prisma = require('./prisma');
const { toMinorInt } = require('./paddleBillingViews');

function upper(value) {
  return value ? String(value).toUpperCase() : null;
}

function paddleTotals(entity) {
  const totals = entity?.details?.totals || entity?.totals || {};
  return {
    currencyCode: upper(totals.currency_code || entity?.currency_code),
    subtotalMinor: toMinorInt(totals.subtotal),
    taxMinor: toMinorInt(totals.tax),
    totalMinor: toMinorInt(totals.grand_total ?? totals.total),
  };
}

function productKindFromPayload(payload, fallback = 'PLAN') {
  return upper(payload?.custom_data?.productKind || payload?.custom_data?.product_kind || fallback) || fallback;
}

function checkoutKindFromPayload(payload) {
  return payload?.custom_data?.checkoutKind || payload?.custom_data?.checkout_kind || null;
}

async function findPurchaseForPaddle({ transactionId = null, subscriptionId = null } = {}) {
  const where = [];
  if (transactionId) where.push({ paddleTransactionId: transactionId });
  if (subscriptionId) where.push({ paddleSubscriptionId: subscriptionId });
  if (!where.length || !prisma.billingPurchase) return null;
  return prisma.billingPurchase.findFirst({ where: { OR: where } });
}

async function recordCheckoutCreated({
  businessId,
  productKind = 'PLAN',
  checkoutKind = 'plan_subscription',
  transaction,
  expectedPriceId = null,
  expectedCurrencyCode = null,
  expectedAmountMinor = null,
  metadata = {},
} = {}) {
  if (!prisma.billingPurchase || !businessId || !transaction?.id) return null;

  return prisma.billingPurchase.upsert({
    where: { paddleTransactionId: transaction.id },
    update: {
      productKind,
      checkoutKind,
      status: upper(transaction.status) || 'CHECKOUT_CREATED',
      expectedPriceId,
      expectedCurrencyCode: upper(expectedCurrencyCode),
      expectedAmountMinor: Number.isFinite(expectedAmountMinor) ? expectedAmountMinor : null,
      paddleCustomerId: transaction.customer_id || null,
      paddleSubscriptionId: transaction.subscription_id || null,
      metadata,
    },
    create: {
      businessId,
      productKind,
      checkoutKind,
      status: upper(transaction.status) || 'CHECKOUT_CREATED',
      expectedPriceId,
      expectedCurrencyCode: upper(expectedCurrencyCode),
      expectedAmountMinor: Number.isFinite(expectedAmountMinor) ? expectedAmountMinor : null,
      paddleCustomerId: transaction.customer_id || null,
      paddleTransactionId: transaction.id,
      paddleSubscriptionId: transaction.subscription_id || null,
      metadata,
    },
  });
}

async function upsertPurchaseFromPaddleTransaction(transaction, { businessId = null, fallbackProductKind = 'PLAN' } = {}) {
  if (!prisma.billingPurchase || !transaction?.id) return null;
  const resolvedBusinessId = businessId || transaction?.custom_data?.businessId || null;
  if (!resolvedBusinessId) return null;

  const totals = paddleTotals(transaction);
  return prisma.billingPurchase.upsert({
    where: { paddleTransactionId: transaction.id },
    update: {
      productKind: productKindFromPayload(transaction, fallbackProductKind),
      checkoutKind: checkoutKindFromPayload(transaction),
      status: upper(transaction.status) || 'UNKNOWN',
      actualCurrencyCode: totals.currencyCode,
      actualSubtotalMinor: totals.subtotalMinor,
      actualTaxMinor: totals.taxMinor,
      actualTotalMinor: totals.totalMinor,
      paddleCustomerId: transaction.customer_id || null,
      paddleSubscriptionId: transaction.subscription_id || null,
      invoiceNumber: transaction.invoice_number || null,
      metadata: transaction.custom_data || {},
    },
    create: {
      businessId: resolvedBusinessId,
      productKind: productKindFromPayload(transaction, fallbackProductKind),
      checkoutKind: checkoutKindFromPayload(transaction),
      status: upper(transaction.status) || 'UNKNOWN',
      expectedPriceId: transaction.custom_data?.expectedPriceId || null,
      expectedCurrencyCode: upper(transaction.custom_data?.expectedCurrencyCode),
      expectedAmountMinor: Number.isFinite(Number(transaction.custom_data?.expectedAmountMinor))
        ? Number(transaction.custom_data.expectedAmountMinor)
        : null,
      actualCurrencyCode: totals.currencyCode,
      actualSubtotalMinor: totals.subtotalMinor,
      actualTaxMinor: totals.taxMinor,
      actualTotalMinor: totals.totalMinor,
      paddleCustomerId: transaction.customer_id || null,
      paddleTransactionId: transaction.id,
      paddleSubscriptionId: transaction.subscription_id || null,
      invoiceNumber: transaction.invoice_number || null,
      metadata: transaction.custom_data || {},
    },
  });
}

async function recordPaymentAttemptFromTransaction(transaction, { businessId = null, status = null, failureCode = null, failureMessage = null } = {}) {
  if (!prisma.paymentAttempt || !transaction?.id) return null;
  const resolvedBusinessId = businessId || transaction?.custom_data?.businessId || null;
  if (!resolvedBusinessId) return null;

  const purchase = await findPurchaseForPaddle({
    transactionId: transaction.id,
    subscriptionId: transaction.subscription_id || null,
  });
  const totals = paddleTotals(transaction);
  const attemptStatus = upper(status || transaction.status) || 'UNKNOWN';
  const existing = await prisma.paymentAttempt.findFirst({
    where: {
      businessId: resolvedBusinessId,
      paddleTransactionId: transaction.id,
      status: attemptStatus,
    },
  });
  const data = {
    purchaseId: purchase?.id || null,
    status: attemptStatus,
    amountMinor: totals.totalMinor,
    currencyCode: totals.currencyCode,
    failureCode,
    failureMessage,
    metadata: transaction.custom_data || {},
  };
  if (existing) return prisma.paymentAttempt.update({ where: { id: existing.id }, data });
  return prisma.paymentAttempt.create({
    data: {
      businessId: resolvedBusinessId,
      provider: 'paddle',
      paddleTransactionId: transaction.id,
      ...data,
    },
  });
}

// Gateway-neutral payment recorder for the SaaS-subscription gateways that are
// NOT Paddle (Razorpay / Stripe). Paddle has its own richer recorders above;
// this one takes a single normalized charge/refund and writes a PaymentAttempt
// row so it surfaces in Payment history / Latest payment / Unified billing
// activity exactly like a Paddle transaction. Idempotent via the DB
// @@unique([businessId, paddleTransactionId, status]) — an upsert (not a racy
// find-first-then-create), so a webhook retry / reconcile / redelivery can't
// duplicate a row. The gateway charge id is stored in the existing
// paddleTransactionId column (the generic "gateway txn id" slot) with `provider`
// distinguishing the gateway; the gateway + id are mirrored into metadata. (B18)
async function recordGatewayPayment({
  businessId,
  provider,                 // 'razorpay' | 'stripe'
  gatewayTransactionId,     // pay_… / pi_… — the charge id, used as the dedup key
  amountMinor = null,
  currencyCode = null,
  status = 'COMPLETED',     // COMPLETED | FAILED | REFUNDED
  failureCode = null,
  failureMessage = null,
  metadata = {},
} = {}) {
  // provider is REQUIRED — never silently coerce to 'razorpay' (that would
  // mis-tag a Stripe/Paddle charge and write metadata.gateway=null). (B15)
  if (!prisma.paymentAttempt || !businessId || !gatewayTransactionId || !provider) return null;
  const attemptStatus = upper(status) || 'COMPLETED';
  const data = {
    amountMinor: Number.isFinite(Number(amountMinor)) ? Number(amountMinor) : null,
    currencyCode: upper(currencyCode),
    failureCode,
    failureMessage,
    metadata: { ...(metadata || {}), gateway: upper(provider), gatewayTransactionId },
  };
  return prisma.paymentAttempt.upsert({
    where: { businessId_paddleTransactionId_status: { businessId, paddleTransactionId: gatewayTransactionId, status: attemptStatus } },
    update: data,
    create: {
      businessId,
      provider: String(provider).toLowerCase(),
      paddleTransactionId: gatewayTransactionId,
      status: attemptStatus,
      ...data,
    },
  });
}

async function recordAdjustmentLedger(adjustment, { businessId = null } = {}) {
  if (!prisma.adjustmentLedger || !adjustment) return null;
  const transactionId = adjustment.transaction_id || null;
  const subscriptionId = adjustment.subscription_id || null;
  const purchase = await findPurchaseForPaddle({ transactionId, subscriptionId });
  const resolvedBusinessId = businessId
    || purchase?.businessId
    || adjustment?.custom_data?.businessId
    || null;
  if (!resolvedBusinessId) return null;

  const totals = paddleTotals(adjustment);
  const amountMinor = totals.totalMinor
    ?? toMinorInt(adjustment?.amount)
    ?? toMinorInt(adjustment?.totals?.amount);
  const data = {
    businessId: resolvedBusinessId,
    purchaseId: purchase?.id || null,
    paddleTransactionId: transactionId,
    paddleSubscriptionId: subscriptionId,
    action: upper(adjustment.action) || 'ADJUSTMENT',
    status: upper(adjustment.status) || 'UNKNOWN',
    reason: adjustment.reason || null,
    currencyCode: totals.currencyCode || upper(adjustment.currency_code),
    amountMinor,
    raw: adjustment,
  };

  if (adjustment.id) {
    return prisma.adjustmentLedger.upsert({
      where: { paddleAdjustmentId: adjustment.id },
      update: data,
      create: {
        paddleAdjustmentId: adjustment.id,
        ...data,
      },
    });
  }

  return prisma.adjustmentLedger.create({ data });
}

module.exports = {
  recordAdjustmentLedger,
  recordCheckoutCreated,
  recordGatewayPayment,
  recordPaymentAttemptFromTransaction,
  upsertPurchaseFromPaddleTransaction,
};
