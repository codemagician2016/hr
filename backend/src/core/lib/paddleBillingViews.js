const prisma = require('./prisma');

function toMinorInt(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function extractAfterCursor(nextUrl) {
  if (!nextUrl) return null;
  try {
    return new URL(nextUrl).searchParams.get('after') || null;
  } catch {
    return null;
  }
}

function extractPrimaryPriceIdFromTransaction(transaction) {
  const sources = [
    ...(Array.isArray(transaction?.items) ? transaction.items : []),
    ...(Array.isArray(transaction?.details?.line_items) ? transaction.details.line_items : []),
  ];

  for (const item of sources) {
    if (item?.price?.id) return item.price.id;
    if (item?.price_id) return item.price_id;
  }
  return null;
}

function invoiceAvailableForTransaction(transaction) {
  const status = String(transaction?.status || '').toLowerCase();
  const collectionMode = String(transaction?.collection_mode || '').toLowerCase();
  const totalMinor = toMinorInt(
    transaction?.details?.totals?.grand_total ?? transaction?.details?.totals?.total
  );

  if (!totalMinor) return false;
  if (collectionMode === 'manual') return status === 'billed' || status === 'completed';
  return status === 'completed';
}

async function buildBillingContext(transactions) {
  const subscriptionIds = new Set();
  const customerIds = new Set();
  const businessIds = new Set();
  const priceIds = new Set();

  for (const transaction of transactions) {
    if (transaction?.subscription_id) subscriptionIds.add(transaction.subscription_id);
    if (transaction?.customer_id) customerIds.add(transaction.customer_id);
    if (transaction?.custom_data?.businessId) businessIds.add(transaction.custom_data.businessId);
    const priceId = extractPrimaryPriceIdFromTransaction(transaction);
    if (priceId) priceIds.add(priceId);
  }

  const subscriptionWhere = [];
  if (subscriptionIds.size > 0) {
    subscriptionWhere.push({ paddleSubscriptionId: { in: [...subscriptionIds] } });
  }
  if (customerIds.size > 0) {
    subscriptionWhere.push({ paddleCustomerId: { in: [...customerIds] } });
  }

  const priceWhere = [];
  if (priceIds.size > 0) {
    priceWhere.push({ paddlePriceIdMonthly: { in: [...priceIds] } });
    priceWhere.push({ paddlePriceIdAnnual: { in: [...priceIds] } });
  }

  const [subscriptions, businesses, tierPrices] = await Promise.all([
    subscriptionWhere.length > 0
      ? prisma.subscription.findMany({
          where: { OR: subscriptionWhere },
          select: {
            businessId: true,
            status: true,
            paddleCustomerId: true,
            paddleSubscriptionId: true,
            business: { select: { id: true, name: true, slug: true } },
            tier: { select: { name: true, slug: true } },
          },
        })
      : Promise.resolve([]),
    prisma.business.findMany({
      where: { id: { in: [...businessIds] } },
      select: { id: true, name: true, slug: true },
    }),
    priceWhere.length > 0
      ? prisma.tierPrice.findMany({
          where: { OR: priceWhere },
          include: { tier: { select: { name: true, slug: true } } },
        })
      : Promise.resolve([]),
  ]);

  const subscriptionByPaddleSubscriptionId = new Map();
  const subscriptionByPaddleCustomerId = new Map();
  for (const subscription of subscriptions) {
    if (subscription.paddleSubscriptionId) {
      subscriptionByPaddleSubscriptionId.set(subscription.paddleSubscriptionId, subscription);
    }
    if (subscription.paddleCustomerId && !subscriptionByPaddleCustomerId.has(subscription.paddleCustomerId)) {
      subscriptionByPaddleCustomerId.set(subscription.paddleCustomerId, subscription);
    }
  }

  const businessById = new Map(businesses.map((business) => [business.id, business]));
  const tierByPriceId = new Map();
  for (const tierPrice of tierPrices) {
    if (tierPrice.paddlePriceIdMonthly) {
      tierByPriceId.set(tierPrice.paddlePriceIdMonthly, {
        tier: tierPrice.tier,
        billingCycle: 'MONTHLY',
      });
    }
    if (tierPrice.paddlePriceIdAnnual) {
      tierByPriceId.set(tierPrice.paddlePriceIdAnnual, {
        tier: tierPrice.tier,
        billingCycle: 'YEARLY',
      });
    }
  }

  return {
    subscriptionByPaddleSubscriptionId,
    subscriptionByPaddleCustomerId,
    businessById,
    tierByPriceId,
  };
}

function serializeBillingTransaction(transaction, context) {
  const priceMatch = context.tierByPriceId.get(extractPrimaryPriceIdFromTransaction(transaction));
  const linkedSubscription = (
    transaction?.subscription_id
      ? context.subscriptionByPaddleSubscriptionId.get(transaction.subscription_id)
      : null
  ) || context.subscriptionByPaddleCustomerId.get(transaction?.customer_id);
  const linkedBusiness = linkedSubscription?.business
    || context.businessById.get(transaction?.custom_data?.businessId)
    || null;
  const tier = priceMatch?.tier || linkedSubscription?.tier || null;

  return {
    id: transaction.id,
    status: String(transaction?.status || '').toUpperCase(),
    origin: transaction?.origin || null,
    collectionMode: transaction?.collection_mode || null,
    currencyCode: transaction?.details?.totals?.currency_code || transaction?.currency_code || null,
    subtotalMinor: toMinorInt(transaction?.details?.totals?.subtotal),
    discountMinor: toMinorInt(transaction?.details?.totals?.discount),
    taxMinor: toMinorInt(transaction?.details?.totals?.tax),
    totalMinor: toMinorInt(transaction?.details?.totals?.grand_total ?? transaction?.details?.totals?.total),
    balanceMinor: toMinorInt(transaction?.details?.totals?.balance),
    feeMinor: toMinorInt(transaction?.details?.totals?.fee),
    earningsMinor: toMinorInt(transaction?.details?.totals?.earnings),
    invoiceNumber: transaction?.invoice_number || null,
    createdAt: transaction?.created_at || null,
    updatedAt: transaction?.updated_at || null,
    billedAt: transaction?.billed_at || null,
    paidAt: String(transaction?.status || '').toLowerCase() === 'completed'
      ? transaction?.billed_at || transaction?.updated_at || null
      : null,
    billingPeriod: {
      startsAt: transaction?.billing_period?.starts_at || null,
      endsAt: transaction?.billing_period?.ends_at || null,
    },
    plan: tier
      ? {
          name: tier.name,
          slug: tier.slug,
          billingCycle: priceMatch?.billingCycle || null,
        }
      : null,
    business: linkedBusiness
      ? {
          id: linkedBusiness.id,
          name: linkedBusiness.name,
          slug: linkedBusiness.slug,
        }
      : transaction?.custom_data?.businessSlug
        ? {
            id: transaction?.custom_data?.businessId || null,
            name: transaction?.custom_data?.businessName || transaction.custom_data.businessSlug,
            slug: transaction.custom_data.businessSlug,
          }
        : null,
    subscription: linkedSubscription
      ? {
          status: linkedSubscription.status,
          paddleSubscriptionId: linkedSubscription.paddleSubscriptionId || null,
          paddleCustomerId: linkedSubscription.paddleCustomerId || null,
        }
      : {
          status: null,
          paddleSubscriptionId: transaction?.subscription_id || null,
          paddleCustomerId: transaction?.customer_id || null,
        },
    hasInvoice: invoiceAvailableForTransaction(transaction),
  };
}

module.exports = {
  buildBillingContext,
  extractAfterCursor,
  extractPrimaryPriceIdFromTransaction,
  invoiceAvailableForTransaction,
  serializeBillingTransaction,
  toMinorInt,
};
