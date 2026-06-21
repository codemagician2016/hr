const prisma = require('../lib/prisma');
const { ROLES } = require('../lib/roles');
const {
  ensureBusinessSubscription,
  extractPrimaryPaddlePriceId,
  findTierForPaddlePriceId,
  getFreeTier,
  syncBusinessSubscriptionFromPaddle,
} = require('../lib/subscriptionBilling');
const {
  cancelPaddleSubscription,
  getPaddleSubscription,
  getPaddleWebhookSecret,
  getPaddleWebhookToleranceSeconds,
  verifyPaddleWebhookSignature,
} = require('../lib/paddle');
const {
  sendSubscriptionStartedEmail,
  sendPaymentFailedEmail,
  sendSubscriptionCancelledEmail,
} = require('../utils/email');
const {
  completePaidDomainRegistration,
  completePaidDomainRenewal,
  isDomainRegistrationPayment,
  isDomainRenewalPayment,
  markDomainPaymentFailed,
  handleDomainPaymentAdjustment,
} = require('../../domains/domainService');
const { provisionMailbox } = require('../lib/mailboxProvisioning');
const { addOveragePurchaseOnce, getCurrentCycle } = require('../lib/notifications/budgetEngine');
const {
  recordAdjustmentLedger,
  recordPaymentAttemptFromTransaction,
  upsertPurchaseFromPaddleTransaction,
} = require('../lib/billingLedger');

const WEBHOOK_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  PROCESSED: 'PROCESSED',
  FAILED: 'FAILED',
};
const PROCESSING_STALE_MS = 10 * 60 * 1000;

function compactError(err, max = 4000) {
  const raw = String(err?.message || err || 'Unknown error');
  return raw.length > max ? `${raw.slice(0, max - 3)}...` : raw;
}

function parsePaddleDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizePaddleEventId(payload) {
  return String(payload?.event_id || '').trim();
}

function paddleEventObjectId(payload) {
  const data = payload?.data || {};
  return String(data.id || data.transaction_id || data.subscription_id || '').trim() || null;
}

function assertWebhookEventStoreAvailable() {
  if (!prisma.paddleWebhookEvent) {
    const err = new Error('Paddle webhook event ledger is not available. Run Prisma migrations and regenerate the client.');
    err.status = 503;
    throw err;
  }
}

function isUniqueConstraintError(err) {
  return err?.code === 'P2002';
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function paddleTransactionCurrency(entity) {
  return upper(
    entity?.currency_code
    || entity?.details?.totals?.currency_code
    || entity?.totals?.currency_code
  );
}

function collectPriceIdsFromEntity(entity) {
  const ids = new Set();
  const items = Array.isArray(entity?.items) ? entity.items : [];
  for (const item of items) {
    const priceId = item?.price?.id || item?.price_id;
    if (priceId) ids.add(String(priceId));
  }
  return ids;
}

function collectUnitPriceAmounts(entity) {
  const amounts = [];
  const items = Array.isArray(entity?.items) ? entity.items : [];
  for (const item of items) {
    const amount = item?.price?.unit_price?.amount || item?.unit_price?.amount;
    const parsed = Number.parseInt(amount, 10);
    if (Number.isFinite(parsed)) amounts.push(parsed);
  }
  return amounts;
}

function makePaddleReconciliationError(message, code = 'PADDLE_RECONCILIATION_FAILED') {
  const err = new Error(message);
  err.status = 409;
  err.code = code;
  return err;
}

function normalizeProductKind(entity) {
  const kind = String(entity?.custom_data?.kind || entity?.custom_data?.productKind || 'plan').trim().toLowerCase();
  if (kind === 'mailbox' || kind === 'business_email') return 'MAILBOX';
  if (kind === 'domain' || kind === 'domain_registration' || kind === 'domain_renewal') return 'DOMAIN';
  if (kind === 'sms' || kind === 'sms_topup' || kind === 'messaging_topup') return 'SMS';
  if (kind === 'plan' || kind === 'subscription' || kind === '') return 'PLAN';
  return 'OTHER';
}

function productRefForEntity(entity, productKind) {
  const custom = entity?.custom_data || {};
  if (productKind === 'MAILBOX') {
    return String(custom.mailboxAddress || custom.address || '').trim().toLowerCase();
  }
  if (productKind === 'DOMAIN') {
    return String(custom.domainName || custom.domain || '').trim().toLowerCase();
  }
  if (productKind === 'SMS') {
    const cycle = String(custom.cycle || '').trim();
    const amount = String(custom.amountUsd || '').trim();
    return [cycle, amount].filter(Boolean).join(':') || String(entity?.id || '').trim() || 'sms';
  }
  if (productKind === 'PLAN') return 'plan';
  return String(custom.productRef || entity?.id || '').trim() || 'unknown';
}

function billingCycleFromPaddle(entity) {
  const interval = String(entity?.billing_cycle?.interval || '').toLowerCase();
  if (!interval) return null;
  const frequency = Number.parseInt(entity?.billing_cycle?.frequency || 1, 10) || 1;
  return frequency === 1 ? interval.toUpperCase() : `${frequency}_${interval.toUpperCase()}`;
}

function firstUnitAmountMinor(entity) {
  const amounts = collectUnitPriceAmounts(entity);
  return amounts.length ? amounts[0] : null;
}

async function upsertPaddleBillingSubscriptionRecord({ entity, transaction = null, meta = {} } = {}) {
  if (!prisma.paddleBillingSubscription) return null;

  const source = entity || transaction || {};
  const productKind = normalizeProductKind(source);
  const productRef = productRefForEntity(source, productKind);
  const businessId = await resolveBusinessIdFromPaddleEntity(source);
  if (!businessId || !productRef) return null;

  const period = source.current_billing_period || {};
  const data = {
    status: String(source.status || transaction?.status || 'unknown').toUpperCase(),
    billingCycle: billingCycleFromPaddle(source),
    quantity: Number.parseInt(source.items?.[0]?.quantity || transaction?.items?.[0]?.quantity || 1, 10) || 1,
    currencyCode: paddleTransactionCurrency(source) || paddleTransactionCurrency(transaction) || null,
    unitAmountMinor: firstUnitAmountMinor(source) ?? firstUnitAmountMinor(transaction),
    paddleCustomerId: source.customer_id || transaction?.customer_id || null,
    paddleSubscriptionId: source.id?.startsWith?.('sub_') ? source.id : (source.subscription_id || transaction?.subscription_id || null),
    paddleTransactionId: transaction?.id || (source.id?.startsWith?.('txn_') ? source.id : (source.transaction_id || null)),
    currentPeriodStart: parsePaddleDate(period.starts_at),
    currentPeriodEnd: parsePaddleDate(period.ends_at),
    nextBilledAt: parsePaddleDate(source.next_billed_at),
    scheduledChangeAction: source.scheduled_change?.action || null,
    lastPaddleEventAt: meta.occurredAt || paddleSubscriptionUpdatedAtForRecord(source),
    lastPaddleEventId: meta.eventId || null,
    metadata: source.custom_data || transaction?.custom_data || {},
  };

  const existing = await prisma.paddleBillingSubscription.findUnique({
    where: {
      businessId_productKind_productRef: {
        businessId,
        productKind,
        productRef,
      },
    },
  }).catch(() => null);

  if (existing?.lastPaddleEventAt && data.lastPaddleEventAt) {
    const previous = new Date(existing.lastPaddleEventAt).getTime();
    if (data.lastPaddleEventAt.getTime() < previous) return existing;
  }

  if (existing) {
    return prisma.paddleBillingSubscription.update({
      where: { id: existing.id },
      data,
    });
  }

  return prisma.paddleBillingSubscription.create({
    data: {
      businessId,
      productKind,
      productRef,
      ...data,
    },
  });
}

function paddleSubscriptionUpdatedAtForRecord(entity) {
  return parsePaddleDate(entity?.updated_at || entity?.created_at);
}

function grandTotalMinor(entity) {
  const raw = entity?.details?.totals?.grand_total
    ?? entity?.totals?.grand_total
    ?? entity?.details?.totals?.total;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function minorInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function discountTotalMinor(entity) {
  const raw = entity?.details?.totals?.discount
    ?? entity?.totals?.discount
    ?? entity?.details?.totals?.discount_total
    ?? entity?.totals?.discount_total;
  const parsed = minorInt(raw);
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}

function hasAppliedPaddleDiscount(entity) {
  return Boolean(
    entity?.discount_id
    || entity?.discount?.id
    || entity?.custom_data?.adminCouponDiscountId
    || discountTotalMinor(entity) > 0
  );
}

// SOFT reconciliation: a `transaction.completed` is already settled, so we grant
// access and ALERT on any discrepancy rather than throw — throwing would mark the
// event FAILED forever (F-wedge) and lock out a legitimate payment whose expected
// metadata was stale (e.g. a catalog change) or that carried a valid coupon. Ops
// review the warnings; clear tampering is still visible in the logs/event ledger.
function reportSubscriptionPaymentDiscrepancies({ transaction, paddleSubscription, businessId = null }) {
  const custom = transaction?.custom_data || {};
  const discrepancies = [];

  const expectedCurrency = upper(custom.expectedCurrencyCode || custom.currency);
  const actualCurrency = paddleTransactionCurrency(transaction);
  if (expectedCurrency && actualCurrency && expectedCurrency !== actualCurrency) {
    discrepancies.push(`currency ${actualCurrency} != expected ${expectedCurrency}`);
  }

  const expectedPriceId = String(custom.expectedPriceId || '').trim();
  if (expectedPriceId) {
    const priceIds = collectPriceIdsFromEntity(transaction);
    for (const priceId of collectPriceIdsFromEntity(paddleSubscription)) priceIds.add(priceId);
    if (priceIds.size > 0 && !priceIds.has(expectedPriceId)) {
      discrepancies.push(`price [${[...priceIds].join(',')}] != expected ${expectedPriceId}`);
    }
  }

  const expectedAmountMinor = Number.parseInt(custom.expectedAmountMinor, 10);
  if (Number.isFinite(expectedAmountMinor) && expectedAmountMinor > 0) {
    const unitAmounts = collectUnitPriceAmounts(transaction);
    if (unitAmounts.length > 0 && !unitAmounts.includes(expectedAmountMinor)) {
      discrepancies.push(`unit_price [${unitAmounts.join(',')}] != expected ${expectedAmountMinor}`);
    }
    // F8: also reconcile the actual amount charged, not just the catalog unit price.
    const grand = grandTotalMinor(transaction);
    if (grand === 0 && !hasAppliedPaddleDiscount(transaction)) {
      discrepancies.push(`grand_total is 0 while expected ${expectedAmountMinor} (100% discount / mispriced product?)`);
    }
  }

  if (discrepancies.length) {
    console.warn('[paddle webhook] payment reconciliation discrepancy', JSON.stringify({
      businessId,
      transactionId: transaction?.id || null,
      discrepancies,
    }));
  }
  return discrepancies;
}

function throwIfFatalSubscriptionPaymentDiscrepancy(discrepancies) {
  // Price ID is the real anti-fraud guard: it proves the customer paid for the
  // exact Paddle price we told them to. Check it FIRST.
  const priceMismatch = discrepancies.find((item) => item.startsWith('price '));
  if (priceMismatch) {
    const err = new Error(`Paddle transaction price did not match the server checkout snapshot: ${priceMismatch}`);
    err.code = 'PADDLE_PRICE_MISMATCH';
    err.discrepancies = discrepancies;
    throw err;
  }

  // Currency mismatch is NOT fatal on its own. Paddle localizes the charge
  // currency per customer for the SAME price_id (validated above), so a
  // catalog-label currency (e.g. INR) differing from the charged currency
  // (e.g. USD) is config drift, not fraud — and stranding a customer who has
  // already paid is strictly worse. Record it (reportSubscription… already
  // console.warns) and let the subscription sync with Paddle's real currency.
  // The underlying catalog↔Paddle-price currency mismatch is a super-admin fix.
  const currencyMismatch = discrepancies.find((item) => item.startsWith('currency '));
  if (currencyMismatch) {
    console.warn('[paddle webhook] non-fatal currency mismatch (price id matched); proceeding:', currencyMismatch);
  }

  const freeCheckoutMismatch = discrepancies.find((item) => item.startsWith('grand_total is 0'));
  if (freeCheckoutMismatch) {
    const err = new Error(`Paddle transaction total did not match the server checkout snapshot: ${freeCheckoutMismatch}`);
    err.code = 'PADDLE_AMOUNT_MISMATCH';
    err.discrepancies = discrepancies;
    throw err;
  }
}

async function resolveBusinessIdFromPaddleEntity(entity) {
  const customBusinessId = entity?.custom_data?.businessId;
  const eventCustomerId = entity?.customer_id || null;
  if (customBusinessId) {
    // F13: custom_data is client-influenceable in principle, so don't trust it
    // blindly. If the event carries a Paddle customer that is ALREADY mapped to
    // a different business, ignore custom_data and fall through to ID-based
    // resolution. First purchases (customer not yet stored) still trust it.
    if (!eventCustomerId) return customBusinessId;
    const existingForCustomer = await prisma.subscription.findFirst({
      where: { paddleCustomerId: eventCustomerId },
      select: { businessId: true },
    });
    const billingForCustomer = prisma.paddleBillingSubscription
      ? await prisma.paddleBillingSubscription.findFirst({
        where: { paddleCustomerId: eventCustomerId },
        select: { businessId: true },
      }).catch(() => null)
      : null;
    const mappedBusinessId = existingForCustomer?.businessId || billingForCustomer?.businessId || null;
    if (!mappedBusinessId || mappedBusinessId === customBusinessId) return customBusinessId;
    console.warn('[paddle webhook] custom_data.businessId conflicts with Paddle customer mapping; ignoring custom_data', customBusinessId, eventCustomerId);
  }

  const transactionId = entity?.transaction_id || (String(entity?.id || '').startsWith('txn_') ? entity.id : null);
  if (transactionId) {
    const byTransaction = await prisma.subscription.findFirst({
      where: { paddleTransactionId: transactionId },
      select: { businessId: true },
    });
    if (byTransaction?.businessId) return byTransaction.businessId;

    if (prisma.paddleBillingSubscription) {
      const byBillingTransaction = await prisma.paddleBillingSubscription.findFirst({
        where: { paddleTransactionId: transactionId },
        select: { businessId: true },
      }).catch(() => null);
      if (byBillingTransaction?.businessId) return byBillingTransaction.businessId;
    }

    if (prisma.domain) {
      const byDomain = await prisma.domain.findFirst({
        where: {
          OR: [
            { registrarRef: `PADDLE:${transactionId}` },
            { registrationPaddleTransactionId: transactionId },
            { renewalPaddleTransactionId: transactionId },
          ],
        },
        select: { businessId: true },
      }).catch(() => null);
      if (byDomain?.businessId) return byDomain.businessId;
    }
  }

  const subscriptionId = entity?.subscription_id || (String(entity?.id || '').startsWith('sub_') ? entity.id : null);
  if (subscriptionId) {
    const bySubscription = await prisma.subscription.findFirst({
      where: { paddleSubscriptionId: subscriptionId },
      select: { businessId: true },
    });
    if (bySubscription?.businessId) return bySubscription.businessId;

    if (prisma.paddleBillingSubscription) {
      const byBillingSubscription = await prisma.paddleBillingSubscription.findFirst({
        where: { paddleSubscriptionId: subscriptionId },
        select: { businessId: true },
      }).catch(() => null);
      if (byBillingSubscription?.businessId) return byBillingSubscription.businessId;
    }
  }

  if (entity?.customer_id) {
    const byCustomer = await prisma.subscription.findFirst({
      where: { paddleCustomerId: entity.customer_id },
      orderBy: { updatedAt: 'desc' },
      select: { businessId: true },
    });
    if (byCustomer?.businessId) return byCustomer.businessId;
  }

  return null;
}

async function recordPaddleWebhookEvent(payload) {
  assertWebhookEventStoreAvailable();

  const eventId = normalizePaddleEventId(payload);
  if (!eventId) {
    const err = new Error('Paddle webhook payload is missing event_id.');
    err.status = 400;
    throw err;
  }

  const eventType = String(payload?.event_type || '').trim();
  if (!eventType) {
    const err = new Error('Paddle webhook payload is missing event_type.');
    err.status = 400;
    throw err;
  }

  const data = payload?.data || {};
  const businessId = await resolveBusinessIdFromPaddleEntity(data).catch(() => null);
  const record = {
    eventId,
    eventType,
    businessId,
    objectId: paddleEventObjectId(payload),
    notificationId: String(payload?.notification_id || '').trim() || null,
    occurredAt: parsePaddleDate(payload?.occurred_at),
    payload,
  };

  try {
    const created = await prisma.paddleWebhookEvent.create({ data: record });
    return { event: created, duplicate: false, requeued: false };
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;

    const existing = await prisma.paddleWebhookEvent.findUnique({ where: { eventId } });
    if (!existing) throw err;

    const updatedAtMs = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
    const processingIsStale = existing.status === WEBHOOK_STATUS.PROCESSING
      && updatedAtMs
      && Date.now() - updatedAtMs > PROCESSING_STALE_MS;

    if (existing.status === WEBHOOK_STATUS.PROCESSED) {
      return { event: existing, duplicate: true, requeued: false };
    }

    if ([WEBHOOK_STATUS.PENDING, WEBHOOK_STATUS.PROCESSING].includes(existing.status) && !processingIsStale) {
      return { event: existing, duplicate: true, requeued: false };
    }

    const requeued = await prisma.paddleWebhookEvent.update({
      where: { eventId },
      data: {
        ...record,
        status: WEBHOOK_STATUS.PENDING,
        failedAt: null,
        lastError: null,
      },
    });
    return { event: requeued, duplicate: true, requeued: true };
  }
}

async function markPaddleWebhookEventProcessed({ id, businessId = null } = {}) {
  assertWebhookEventStoreAvailable();
  return prisma.paddleWebhookEvent.update({
    where: { id },
    data: {
      status: WEBHOOK_STATUS.PROCESSED,
      businessId: businessId || undefined,
      processedAt: new Date(),
      failedAt: null,
      lastError: null,
    },
  });
}

async function markPaddleWebhookEventFailed({ id, err } = {}) {
  assertWebhookEventStoreAvailable();
  return prisma.paddleWebhookEvent.update({
    where: { id },
    data: {
      status: WEBHOOK_STATUS.FAILED,
      failedAt: new Date(),
      lastError: compactError(err),
    },
  });
}

async function hasProcessedTransactionCompleted(transactionId) {
  assertWebhookEventStoreAvailable();
  if (!transactionId) return false;
  const row = await prisma.paddleWebhookEvent.findFirst({
    where: {
      eventType: 'transaction.completed',
      objectId: transactionId,
      status: WEBHOOK_STATUS.PROCESSED,
    },
    select: { id: true },
  });
  return Boolean(row);
}

async function handleTransactionCompleted(entity, meta = {}) {
  if (String(entity?.status || '').toLowerCase() !== 'completed') {
    throw makePaddleReconciliationError(
      `transaction.completed webhook carried non-completed status ${entity?.status || 'unknown'}.`,
      'PADDLE_TRANSACTION_STATUS_MISMATCH'
    );
  }

  if (isDomainRegistrationPayment(entity)) {
    const businessId = await resolveBusinessIdFromPaddleEntity(entity).catch(() => null);
    if (businessId) {
      await upsertPurchaseFromPaddleTransaction(entity, {
        businessId,
        fallbackProductKind: 'DOMAIN',
      }).catch((err) => console.error('[paddle webhook] domain billing ledger transaction write failed', err?.message || err));
      await recordPaymentAttemptFromTransaction(entity, {
        businessId,
        status: entity?.status || 'completed',
      }).catch((err) => console.error('[paddle webhook] domain billing ledger payment-attempt write failed', err?.message || err));
    }
    await completePaidDomainRegistration({ prisma, entity });
    return;
  }
  if (isDomainRenewalPayment(entity)) {
    const businessId = await resolveBusinessIdFromPaddleEntity(entity).catch(() => null);
    if (businessId) {
      await upsertPurchaseFromPaddleTransaction(entity, {
        businessId,
        fallbackProductKind: 'DOMAIN',
      }).catch((err) => console.error('[paddle webhook] domain renewal billing ledger transaction write failed', err?.message || err));
      await recordPaymentAttemptFromTransaction(entity, {
        businessId,
        status: entity?.status || 'completed',
      }).catch((err) => console.error('[paddle webhook] domain renewal billing ledger payment-attempt write failed', err?.message || err));
    }
    await completePaidDomainRenewal({ prisma, entity });
    return;
  }

  const productKind = normalizeProductKind(entity);
  const businessId = await resolveBusinessIdFromPaddleEntity(entity);
  if (!businessId) {
    console.warn('[paddle webhook] no business match for transaction.completed', entity?.id || 'unknown');
    return;
  }
  await upsertPurchaseFromPaddleTransaction(entity, {
    businessId,
    fallbackProductKind: productKind,
  }).catch((err) => console.error('[paddle webhook] billing ledger transaction write failed', err?.message || err));
  await recordPaymentAttemptFromTransaction(entity, {
    businessId,
    status: entity?.status || 'completed',
  }).catch((err) => console.error('[paddle webhook] billing ledger payment-attempt write failed', err?.message || err));

  if (productKind === 'SMS') {
    await handleSmsTopupTransactionCompleted(entity, { businessId, meta });
    return;
  }

  // Idempotency guard. Paddle delivers webhooks at-least-once; if we
  // already processed this exact transaction (same ID stored on the
  // subscription row), skip the side-effects so a replay doesn't fire
  // duplicate "Subscription started" emails or stamp redundant data.
  const existingSub = await prisma.subscription.findUnique({
    where: { businessId },
    select: { paddleTransactionId: true },
  });
  const isReplay = entity?.id && existingSub?.paddleTransactionId === entity.id;
  if (isReplay) {
    console.log('[paddle webhook] duplicate transaction.completed ignored', entity.id);
    return;
  }

  await ensureBusinessSubscription(businessId);

  // Stamp defaultCurrency from the payment currency on first subscription only.
  // updateMany with defaultCurrency:null in the where is a no-op on renewals/upgrades.
  const paidCurrency = (entity?.currency_code || '').toUpperCase();
  if (paidCurrency) {
    await prisma.business.updateMany({
      where: { id: businessId, defaultCurrency: null },
      data: { defaultCurrency: paidCurrency },
    });
  }

  if (entity?.subscription_id) {
    const paddleSubscription = await getPaddleSubscription(entity.subscription_id);
    await upsertPaddleBillingSubscriptionRecord({
      entity: paddleSubscription,
      transaction: entity,
      meta,
    });
    if (productKind !== 'PLAN' || normalizeProductKind(paddleSubscription) !== 'PLAN') {
      await handleNonPlanBillingSubscriptionChange(paddleSubscription, { ...meta, transaction: entity });
      return;
    }
    const discrepancies = reportSubscriptionPaymentDiscrepancies({
      transaction: entity,
      paddleSubscription,
      businessId,
    });
    throwIfFatalSubscriptionPaymentDiscrepancy(discrepancies);
    await syncBusinessSubscriptionFromPaddle({
      businessId,
      paddleSubscription,
      paddleTransactionId: entity?.id || null,
      paddleEventOccurredAt: meta.occurredAt,
      paddleEventId: meta.eventId,
      ...(entity?.custom_data?.targetVertical ? { targetVertical: entity.custom_data.targetVertical } : {}),
    });
    if (entity?.origin === 'web') {
      await sendSubscriptionStartedNotification(businessId);
    }
    return;
  }

  await prisma.subscription.update({
    where: { businessId },
    data: {
      paddleCustomerId: entity?.customer_id || undefined,
      paddleSubscriptionId: entity?.subscription_id || undefined,
      paddleTransactionId: entity?.id || undefined,
    },
  });

  // Only send "Started" if it's the first transaction for a new subscription (i.e. origin is web)
  // or simply when the transaction is completed and it's a subscription transaction.
  if (entity?.origin === 'web') {
    await sendSubscriptionStartedNotification(businessId);
  }
}

async function handleNonPlanBillingSubscriptionChange(entity, meta = {}) {
  const productKind = normalizeProductKind(entity);
  if (productKind === 'PLAN') return false;
  const status = String(entity?.status || '').toLowerCase();

  if (productKind === 'MAILBOX' && ['active', 'trialing'].includes(status) && !meta.transaction) {
    console.warn('[paddle webhook] deferring mailbox provisioning until transaction.completed confirms payment', entity?.id || 'unknown');
    await upsertPaddleBillingSubscriptionRecord({ entity, transaction: null, meta });
    return true;
  }

  await upsertPaddleBillingSubscriptionRecord({ entity, transaction: meta.transaction || null, meta });

  if (productKind === 'MAILBOX') {
    await handleMailboxBillingSubscriptionChange(entity, meta);
    return true;
  }

  return true;
}

async function handleMailboxBillingSubscriptionChange(entity, meta = {}) {
  const custom = entity?.custom_data || meta.transaction?.custom_data || {};
  const businessId = await resolveBusinessIdFromPaddleEntity(entity);
  const address = String(custom.mailboxAddress || '').trim().toLowerCase();
  const domain = String(custom.domain || '').trim().toLowerCase();
  const localPart = String(custom.localPart || address.split('@')[0] || '').trim().toLowerCase();
  const deliverTo = String(custom.deliverTo || custom.userEmail || '').trim();
  const status = String(entity?.status || '').toLowerCase();
  if (!businessId || !address || !domain) return;

  if (status === 'active') {
    const existing = await prisma.mailbox?.findUnique({
      where: { businessId_address: { businessId, address } },
    }).catch(() => null);
    if (!existing || !['ACTIVE', 'PROVISIONING'].includes(String(existing.status || '').toUpperCase())) {
      await provisionMailbox({
        businessId,
        localPart,
        domain,
        deliverTo,
        businessName: custom.businessName || null,
      });
    }
  }

  await prisma.mailbox?.updateMany({
    where: { businessId, address },
    data: {
      status: ['past_due', 'paused', 'canceled'].includes(status) ? 'SUSPENDED' : undefined,
      billingStatus: status.toUpperCase() || null,
      billingCycle: String(custom.billingCycle || billingCycleFromPaddle(entity) || '').toUpperCase() || null,
      billingQuantity: Number.parseInt(entity?.items?.[0]?.quantity || custom.quantity || 1, 10) || 1,
      paddleCustomerId: entity?.customer_id || meta.transaction?.customer_id || null,
      paddleSubscriptionId: entity?.id || meta.transaction?.subscription_id || null,
      paddleTransactionId: meta.transaction?.id || entity?.transaction_id || null,
      statusMessage: ['past_due', 'paused', 'canceled'].includes(status)
        ? `Mailbox billing is ${status.replace('_', ' ')}. Update billing to keep this mailbox active.`
        : undefined,
    },
  }).catch(() => null);
}

async function handleTransactionFailed(entity) {
  if (isDomainRegistrationPayment(entity)) {
    await markDomainPaymentFailed({ prisma, entity });
    return;
  }
  if (isDomainRenewalPayment(entity)) {
    await markDomainPaymentFailed({ prisma, entity });
    return;
  }

  const businessId = await resolveBusinessIdFromPaddleEntity(entity);
  if (!businessId) return;
  await recordPaymentAttemptFromTransaction(entity, {
    businessId,
    status: entity?.status || 'payment_failed',
    failureCode: entity?.payments?.[0]?.error_code || entity?.error_code || null,
    failureMessage: entity?.payments?.[0]?.error_message || entity?.error_message || null,
  }).catch((err) => console.error('[paddle webhook] billing ledger failed-payment write failed', err?.message || err));

  const admin = await prisma.user.findFirst({
    where: { businessId, role: ROLES.BUSINESS_ADMIN },
    select: { name: true, email: true },
  });
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } });
  if (admin && admin.email) {
    sendPaymentFailedEmail(admin.email, admin.name, {
      businessName: business?.name || 'your business',
      businessId,
    }).catch(e => console.error('Payment failed email failed:', e.message));
  }
}

async function handleTransactionCanceled(entity) {
  if (isDomainRegistrationPayment(entity) || isDomainRenewalPayment(entity)) {
    await markDomainPaymentFailed({ prisma, entity });
  }
  const businessId = await resolveBusinessIdFromPaddleEntity(entity).catch(() => null);
  if (businessId) {
    await recordPaymentAttemptFromTransaction(entity, {
      businessId,
      status: entity?.status || 'canceled',
    }).catch((err) => console.error('[paddle webhook] billing ledger canceled-payment write failed', err?.message || err));
  }
}

function paddleSubscriptionTransactionId(entity, before = null) {
  return String(
    entity?.transaction_id
    || entity?.latest_transaction_id
    || entity?.first_transaction_id
    || before?.paddleTransactionId
    || ''
  ).trim();
}

async function shouldDeferPaidSubscriptionChangeUntilTransactionCompleted({ entity, before }) {
  const paddleStatus = String(entity?.status || '').toLowerCase();
  if (!['active', 'trialing'].includes(paddleStatus)) return false;

  const matched = await findTierForPaddlePriceId(extractPrimaryPaddlePriceId(entity));
  const nextTierSlug = String(matched?.tier?.slug || '').toLowerCase();
  if (!nextTierSlug || nextTierSlug === 'free') return false;

  const beforeTierSlug = String(before?.tier?.slug || '').toLowerCase();
  const beforeStatus = String(before?.status || '').toUpperCase();
  const sameKnownPaidSubscription = before?.paddleSubscriptionId === entity?.id
    && beforeTierSlug === nextTierSlug
    && ['ACTIVE', 'TRIALING'].includes(beforeStatus);
  if (sameKnownPaidSubscription) return false;

  const transactionId = paddleSubscriptionTransactionId(entity, before);
  if (!transactionId) return true;

  return !(await hasProcessedTransactionCompleted(transactionId));
}

const SMS_TOPUP_AMOUNTS = new Set([5, 20, 50]);

function parseSmsTopupCycle(value) {
  const cycle = String(value || '').trim();
  return /^\d{4}-\d{2}$/.test(cycle) ? cycle : getCurrentCycle();
}

async function handleSmsTopupTransactionCompleted(entity, { businessId, meta = {} } = {}) {
  const custom = entity?.custom_data || {};
  const amountUsd = Number(custom.amountUsd || custom.topupAmountUsd);
  if (!SMS_TOPUP_AMOUNTS.has(amountUsd)) {
    throw makePaddleReconciliationError(
      `SMS top-up transaction carried an unsupported amount: ${custom.amountUsd || 'missing'}.`,
      'PADDLE_SMS_TOPUP_AMOUNT_INVALID'
    );
  }

  const expectedAmountMinor = Number.parseInt(custom.expectedAmountMinor, 10);
  if (!Number.isFinite(expectedAmountMinor) || expectedAmountMinor !== amountUsd * 100) {
    throw makePaddleReconciliationError(
      'SMS top-up transaction did not match the expected USD pack amount.',
      'PADDLE_SMS_TOPUP_EXPECTED_AMOUNT_MISMATCH'
    );
  }

  const expectedCurrency = upper(custom.expectedCurrencyCode || 'USD');
  const actualCurrency = paddleTransactionCurrency(entity);
  if (expectedCurrency && actualCurrency && expectedCurrency !== actualCurrency) {
    throw makePaddleReconciliationError(
      `SMS top-up currency ${actualCurrency} did not match expected ${expectedCurrency}.`,
      'PADDLE_SMS_TOPUP_CURRENCY_MISMATCH'
    );
  }

  const actualTotalMinor = grandTotalMinor(entity);
  if (!Number.isFinite(actualTotalMinor) || actualTotalMinor < expectedAmountMinor) {
    throw makePaddleReconciliationError(
      'SMS top-up transaction total was lower than the requested credit amount.',
      'PADDLE_SMS_TOPUP_TOTAL_MISMATCH'
    );
  }

  const discountMinor = discountTotalMinor(entity);
  if (discountMinor > 0) {
    throw makePaddleReconciliationError(
      'SMS top-up transactions cannot be discounted because the credit value must equal settled payment.',
      'PADDLE_SMS_TOPUP_DISCOUNT_BLOCKED'
    );
  }

  const purchase = prisma.billingPurchase
    ? await prisma.billingPurchase.findUnique({
      where: { paddleTransactionId: entity.id },
      select: { id: true },
    }).catch(() => null)
    : null;

  const result = await addOveragePurchaseOnce({
    businessId,
    amountUsd,
    cycle: parseSmsTopupCycle(custom.cycle),
    paddleTransactionId: entity.id,
    purchaseId: purchase?.id || null,
    metadata: {
      eventId: meta.eventId || null,
      checkoutKind: custom.checkoutKind || 'sms_topup',
      expectedAmountMinor,
      actualTotalMinor,
      currencyCode: actualCurrency || expectedCurrency || 'USD',
    },
  });

  if (result.granted) {
    console.log('[paddle webhook] SMS top-up granted', JSON.stringify({
      businessId,
      transactionId: entity.id,
      amountUsd,
      cycle: parseSmsTopupCycle(custom.cycle),
    }));
  } else {
    console.log('[paddle webhook] duplicate SMS top-up grant ignored', entity.id);
  }
}

async function sendSubscriptionStartedNotification(businessId) {
  const admin = await prisma.user.findFirst({
    where: { businessId, role: ROLES.BUSINESS_ADMIN },
    select: { name: true, email: true },
  });
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } });
  if (admin && admin.email) {
    await sendSubscriptionStartedEmail(admin.email, admin.name, {
      businessName: business?.name || 'your business',
      businessId,
    }).catch(e => console.error('Subscription started email failed:', e.message));
  }
}

async function handleSubscriptionChange(entity, meta = {}) {
  const businessId = await resolveBusinessIdFromPaddleEntity(entity);
  if (!businessId) {
    console.warn('[paddle webhook] no business match for subscription event', entity?.id || 'unknown');
    return;
  }

  if (await handleNonPlanBillingSubscriptionChange(entity, meta)) {
    return;
  }

  // Idempotency: capture status BEFORE sync so we only email when the
  // status actually transitioned. A duplicate webhook with the same status
  // shouldn't trigger another "cancelled" / "past_due" email.
  const before = await prisma.subscription.findUnique({
    where: { businessId },
    select: {
      status: true,
      paddleSubscriptionId: true,
      paddleTransactionId: true,
      tier: { select: { slug: true } },
    },
  });
  const previousStatus = before?.status || null;

  if (await shouldDeferPaidSubscriptionChangeUntilTransactionCompleted({ entity, before })) {
    console.warn('[paddle webhook] deferring paid subscription sync until transaction.completed is processed', entity?.id || 'unknown');
    return;
  }

  await syncBusinessSubscriptionFromPaddle({
    businessId,
    paddleSubscription: entity,
    paddleTransactionId: entity?.transaction_id || null,
    paddleEventOccurredAt: meta.occurredAt,
    paddleEventId: meta.eventId,
    ...(entity?.custom_data?.targetVertical ? { targetVertical: entity.custom_data.targetVertical } : {}),
  });

  const paddleStatus = String(entity?.status || '').toLowerCase();
  // Duplicate / replayed cancel: a 'canceled' event for a subscription that no
  // longer carries a local Paddle id has ALREADY been processed (the first
  // cancel nulled the id + downgraded the tier). Skip regardless of WHICH free
  // tier it landed on. The old `tier.slug === 'free'` check missed ecom-free /
  // static-free, so the webhook-retry cron ('7,37 * * * *') re-sent the
  // cancellation email every 30 minutes to ecom/static tenants (the ecom8 spam).
  const wasAlreadyCanceledLocally = paddleStatus === 'canceled'
    && !before?.paddleSubscriptionId;
  if (wasAlreadyCanceledLocally) {
    console.log('[paddle webhook] subscription already downgraded, skipping duplicate cancellation email', businessId);
    return;
  }

  // Map Paddle status to our internal status enum to compare like-with-like.
  const newInternalStatus = paddleStatus === 'canceled' ? 'CANCELLED'
    : paddleStatus === 'past_due' ? 'PAST_DUE' : null;
  if (newInternalStatus && previousStatus === newInternalStatus) {
    console.log('[paddle webhook] subscription status unchanged, skipping duplicate email', businessId, paddleStatus);
    return;
  }

  if (paddleStatus === 'canceled') {
    // Suppress the "cancelled" email when the cancellation is part of an
    // account deletion — the delete flow has its own messaging, and emailing
    // "subscription cancelled" on top of (or after an undo of) a deletion is
    // what spammed tenants like ecom8.
    const { isBusinessDeletionPending } = require('../lib/accountDeletion');
    if (await isBusinessDeletionPending(businessId)) {
      console.log('[paddle webhook] business deletion pending, skipping cancellation email', businessId);
    } else {
      const admin = await prisma.user.findFirst({
        where: { businessId, role: ROLES.BUSINESS_ADMIN },
        select: { name: true, email: true },
      });
      const business = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } });
      if (admin && admin.email) {
        sendSubscriptionCancelledEmail(admin.email, admin.name, {
          businessName: business?.name || 'your business',
          businessId,
        }).catch(e => console.error('Subscription cancelled email failed:', e.message));
      }
    }
  } else if (paddleStatus === 'past_due') {
    const admin = await prisma.user.findFirst({
      where: { businessId, role: ROLES.BUSINESS_ADMIN },
      select: { name: true, email: true },
    });
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } });
    if (admin && admin.email) {
      sendPaymentFailedEmail(admin.email, admin.name, {
        businessName: business?.name || 'your business',
        businessId,
      }).catch(e => console.error('Payment failed email failed (past_due):', e.message));
    }
  }
}

async function revokeSubscriptionAccessForAdjustedTransaction({ transactionId, subscriptionId, reason }) {
  // C6: match by transaction OR subscription. Subscription.paddleTransactionId
  // holds only the LATEST transaction (overwritten each renewal), so a refund/
  // chargeback referencing an older transaction would silently no-op. Falling
  // back to paddleSubscriptionId fixes that.
  if (!transactionId && !subscriptionId) return { revoked: false };

  const subscription = await prisma.subscription.findFirst({
    where: {
      OR: [
        ...(transactionId ? [{ paddleTransactionId: transactionId }] : []),
        ...(subscriptionId ? [{ paddleSubscriptionId: subscriptionId }] : []),
      ],
    },
    include: { tier: { select: { slug: true } } },
  });
  if (!subscription) return { revoked: false };

  const freeTier = await getFreeTier();
  if (!freeTier) throw new Error('Free tier is missing. Run prisma/seeds/pricing.seed.js first.');

  const isChargeback = reason === 'chargeback';

  // C6: a chargeback means the customer is disputing the charge. Previously we
  // only downgraded the tier — the public storefront stayed live and Paddle kept
  // retrying a disputing customer. Now: cancel the upstream Paddle subscription
  // (stop billing) and hard-suspend the tenant. Both are best-effort/non-blocking.
  if (isChargeback) {
    if (subscription.paddleSubscriptionId) {
      try {
        await cancelPaddleSubscription(subscription.paddleSubscriptionId, { effective_from: 'immediately' });
      } catch (err) {
        console.error('[paddle webhook] chargeback: cancelPaddleSubscription failed', err.message);
      }
    }
    await prisma.business.update({
      where: { id: subscription.businessId },
      data: { isActive: false, suspendedReason: 'Payment disputed (chargeback)', suspendedAt: new Date() },
    }).catch((err) => console.error('[paddle webhook] chargeback: suspend business failed', err.message));
  }

  if (subscription.tier?.slug === 'free' && subscription.tierId === freeTier.id) {
    // Already on free — but for a chargeback we still suspended above.
    return { revoked: isChargeback, idempotent: true, businessId: subscription.businessId };
  }

  await prisma.subscription.update({
    where: { businessId: subscription.businessId },
    data: {
      tierId: freeTier.id,
      status: isChargeback ? 'PAST_DUE' : 'EXPIRED',
      currentPeriodEnd: new Date(),
      pendingTierSlug: null,
      pendingBillingCycle: null,
      pendingChangeEffectiveAt: null,
    },
  });

  return { revoked: true, businessId: subscription.businessId, suspended: isChargeback };
}

async function handleNonPlanAdjustment(entity) {
  if (!prisma.paddleBillingSubscription) return false;
  const transactionId = String(entity?.transaction_id || '').trim();
  const subscriptionId = String(entity?.subscription_id || '').trim();
  if (!transactionId && !subscriptionId) return false;

  const billing = await prisma.paddleBillingSubscription.findFirst({
    where: {
      OR: [
        ...(transactionId ? [{ paddleTransactionId: transactionId }] : []),
        ...(subscriptionId ? [{ paddleSubscriptionId: subscriptionId }] : []),
      ],
    },
  }).catch(() => null);
  if (!billing || billing.productKind === 'PLAN') return false;

  const action = String(entity?.action || '').toLowerCase();
  const status = String(entity?.status || '').toLowerCase();
  if (!['refund', 'chargeback'].includes(action) || status !== 'approved') return true;

  await prisma.paddleBillingSubscription.update({
    where: { id: billing.id },
    data: {
      status: action === 'chargeback' ? 'CHARGEBACK' : 'REFUNDED',
      metadata: {
        ...(billing.metadata && typeof billing.metadata === 'object' ? billing.metadata : {}),
        lastAdjustmentId: entity?.id || null,
        lastAdjustmentAction: action,
        lastAdjustmentStatus: status,
      },
    },
  });

  if (billing.productKind === 'MAILBOX' && billing.productRef) {
    await prisma.mailbox?.updateMany({
      where: { businessId: billing.businessId, address: billing.productRef },
      data: {
        billingStatus: action === 'chargeback' ? 'CHARGEBACK' : 'REFUNDED',
        statusMessage: action === 'chargeback'
          ? 'Mailbox payment was disputed. Mailbox management is locked until billing is resolved.'
          : 'Mailbox payment was refunded. Mailbox management is locked until billing is resolved.',
      },
    }).catch(() => null);
  }

  return true;
}

async function handleAdjustmentChange(entity) {
  const action = String(entity?.action || '').toLowerCase();
  const status = String(entity?.status || '').toLowerCase();
  const type = String(entity?.type || '').toLowerCase();
  const transactionId = String(entity?.transaction_id || '').trim();

  if (!transactionId) return;
  const ledgerBusinessId = await resolveBusinessIdFromPaddleEntity(entity).catch(() => null);
  if (ledgerBusinessId) {
    await recordAdjustmentLedger(entity, { businessId: ledgerBusinessId })
      .catch((err) => console.error('[paddle webhook] billing ledger adjustment write failed', err?.message || err));
  }

  const domainResult = await handleDomainPaymentAdjustment({ prisma, entity }).catch((err) => {
    console.error('[paddle webhook] domain adjustment handling failed:', err?.message || err);
    return { handled: false };
  });
  if (domainResult?.handled) {
    return;
  }

  if (await handleNonPlanAdjustment(entity)) {
    return;
  }

  // In Paddle Billing, refunds are Adjustments and most live refunds start as
  // pending_approval. Only final approved full refunds/chargebacks revoke
  // access; partial refunds and credits are recorded in the event ledger for
  // ops but do not change entitlements.
  if (!['refund', 'chargeback'].includes(action)) return;
  if (status !== 'approved') return;
  if (type && type !== 'full') return;

  const result = await revokeSubscriptionAccessForAdjustedTransaction({
    transactionId,
    subscriptionId: String(entity?.subscription_id || '').trim() || null,
    reason: action,
  });
  if (result.revoked) {
    console.warn('[paddle webhook] revoked subscription access after approved adjustment', transactionId, action);
  }
}

async function dispatchPaddleWebhookPayload(payload) {
  const meta = {
    eventId: normalizePaddleEventId(payload),
    eventType: String(payload?.event_type || '').trim(),
    occurredAt: parsePaddleDate(payload?.occurred_at),
  };
  switch (payload?.event_type) {
    case 'transaction.completed':
      await handleTransactionCompleted(payload.data, meta);
      break;
    case 'transaction.payment_failed':
      await handleTransactionFailed(payload.data);
      break;
    case 'transaction.canceled':
    case 'transaction.past_due':
      await handleTransactionCanceled(payload.data);
      break;
    case 'subscription.created':
    case 'subscription.updated':
    case 'subscription.activated':
    case 'subscription.trialing':
    case 'subscription.past_due':
    case 'subscription.canceled':
    case 'subscription.paused':
    case 'subscription.resumed':
      await handleSubscriptionChange(payload.data, meta);
      break;
    case 'adjustment.created':
    case 'adjustment.updated':
      await handleAdjustmentChange(payload.data);
      break;
    default:
      break;
  }
}

async function processPaddleWebhookEventById(id) {
  assertWebhookEventStoreAvailable();
  if (!id) return { processed: false, reason: 'missing_id' };

  const claim = await prisma.paddleWebhookEvent.updateMany({
    where: {
      id,
      status: { in: [WEBHOOK_STATUS.PENDING, WEBHOOK_STATUS.FAILED] },
    },
    data: {
      status: WEBHOOK_STATUS.PROCESSING,
      attempts: { increment: 1 },
      lastError: null,
    },
  });
  if (!claim?.count) {
    const current = await prisma.paddleWebhookEvent.findUnique({
      where: { id },
      select: { status: true },
    });
    return { processed: false, status: current?.status || null };
  }

  const event = await prisma.paddleWebhookEvent.findUnique({ where: { id } });
  if (!event) return { processed: false, reason: 'missing_row' };

  try {
    const payload = event.payload || {};
    await dispatchPaddleWebhookPayload(payload);
    const businessId = await resolveBusinessIdFromPaddleEntity(payload?.data || {}).catch(() => null);
    await markPaddleWebhookEventProcessed({ id, businessId });
    return { processed: true, eventType: event.eventType };
  } catch (err) {
    await markPaddleWebhookEventFailed({ id, err }).catch((markErr) => {
      console.error('[paddle webhook] could not mark event failed:', markErr?.message || markErr);
    });
    throw err;
  }
}

async function processPendingPaddleWebhookEvents({ limit = 25, maxAttempts = 12 } = {}) {
  assertWebhookEventStoreAvailable();

  const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS);
  await prisma.paddleWebhookEvent.updateMany({
    where: {
      status: WEBHOOK_STATUS.PROCESSING,
      updatedAt: { lt: staleBefore },
    },
    data: {
      status: WEBHOOK_STATUS.FAILED,
      failedAt: new Date(),
      lastError: 'Processing timed out before completion; queued for retry.',
    },
  }).catch((err) => {
    console.error('[paddle webhook] stale processing reset failed:', err?.message || err);
  });

  const events = await prisma.paddleWebhookEvent.findMany({
    where: {
      status: { in: [WEBHOOK_STATUS.PENDING, WEBHOOK_STATUS.FAILED] },
      attempts: { lt: maxAttempts },
    },
    orderBy: [
      { occurredAt: 'asc' },
      { createdAt: 'asc' },
    ],
    take: limit,
  });

  let processed = 0;
  let failed = 0;
  for (const event of events) {
    try {
      const result = await processPaddleWebhookEventById(event.id);
      if (result.processed) processed += 1;
    } catch (err) {
      failed += 1;
      console.error('[paddle webhook] queued event failed:', event.eventId, err?.message || err);
    }
  }

  return { scanned: events.length, processed, failed };
}

function enqueuePaddleWebhookProcessing(id) {
  setImmediate(() => {
    processPaddleWebhookEventById(id).catch((err) => {
      console.error('[paddle webhook] async processing failed:', err?.message || err);
    });
  });
}

async function handlePaddleWebhook(req, res) {
  const secret = getPaddleWebhookSecret();
  if (!secret) {
    return res.status(500).json({ message: 'Paddle webhook secret is not configured.' });
  }

  const signatureHeader = req.get('Paddle-Signature');
  if (!verifyPaddleWebhookSignature({
    rawBody: req.body,
    signatureHeader,
    secret,
    toleranceSeconds: getPaddleWebhookToleranceSeconds(),
  })) {
    return res.status(400).json({ message: 'Invalid Paddle signature.' });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ message: 'Invalid Paddle payload.' });
  }

  try {
    const { event, duplicate, requeued } = await recordPaddleWebhookEvent(payload);
    if (!duplicate || requeued) {
      enqueuePaddleWebhookProcessing(event.id);
    }

    return res.json({
      received: true,
      queued: !duplicate || requeued,
      duplicate,
      eventId: event.eventId,
      status: event.status,
    });
  } catch (err) {
    console.error('[paddle webhook] enqueue failed:', err?.message || err);
    return res.status(err?.status || 500).json({ message: err?.message || 'Webhook processing failed.' });
  }
}

module.exports = {
  dispatchPaddleWebhookPayload,
  handlePaddleWebhook,
  processPaddleWebhookEventById,
  processPendingPaddleWebhookEvents,
  recordPaddleWebhookEvent,
};
