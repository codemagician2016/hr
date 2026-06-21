const prisma = require('./prisma');
const { isPaddleConfigured } = require('./paddle');
const {
  FREE_TIER_SLUG,
  FREE_TIER_SLUGS,
  getPriceIdForBillingCycle,
  normalizeCountryCode,
  resolveTierPriceRecord,
} = require('./subscriptionBilling');
const { resolveVertical } = require('./vertical');
const {
  activeGatewayFromSubscription,
  gatewayMigrationBlock,
  resolveGateway,
  resolveGatewayForChange,
} = require('./billing/gatewayRouter');
const {
  changeTiming,
  classifyPlanChange,
  paddleProrationModeFor,
  razorpayScheduleChangeAtFor,
  stripeProrationBehaviorFor,
} = require('./billingPlanChangePolicy');

const VALID_VERTICALS = new Set(['STATIC', 'APPOINTMENT', 'ECOMMERCE']);

const GAINED_BY_TARGET = {
  STATIC: [],
  APPOINTMENT: ['Booking flow', 'Services & schedules', 'Customer accounts', 'Appointment reminders'],
  ECOMMERCE: ['Online store', 'Product catalog', 'Cart & checkout', 'Order management'],
};

function isValidBillingCycle(value) {
  return value === 'MONTHLY' || value === 'YEARLY';
}

function isTrueFreeTier(tier) {
  // Any vertical's free tier (free / static-free / ecom-free) counts as free.
  // The slug is the canonical indicator — don't gate on sortOrder, since the
  // per-vertical free tiers are not all sortOrder 0 (static-free is 1).
  return FREE_TIER_SLUGS.has(tier?.slug);
}

function serializeTier(tier) {
  if (!tier) return null;
  return {
    id: tier.id,
    slug: tier.slug,
    name: tier.name,
    vertical: resolveVertical(tier.vertical),
    sortOrder: Number(tier.sortOrder || 0),
    isCustomPriced: Boolean(tier.isCustomPriced),
  };
}

async function resolveTargetTier({ tierId, tierSlug }) {
  if (tierId) return prisma.pricingTier.findUnique({ where: { id: tierId } });
  if (tierSlug) return prisma.pricingTier.findUnique({ where: { slug: tierSlug } });
  return null;
}

async function buildVerticalImpact({ businessId, currentVertical, targetVertical }) {
  if (currentVertical === targetVertical) {
    return { currentVertical, targetVertical, hidden: {}, gained: [], customerImpact: null, noOp: true };
  }

  const hidden = {};
  if (currentVertical === 'APPOINTMENT') {
    const [services, appointments, schedules] = await Promise.all([
      prisma.service.count({ where: { businessId } }),
      prisma.appointment.count({ where: { businessId } }),
      prisma.staffSchedule.count({ where: { staff: { businessId } } }),
    ]);
    if (services > 0) hidden.services = services;
    if (appointments > 0) hidden.appointments = appointments;
    if (schedules > 0) hidden.schedules = schedules;
  } else if (currentVertical === 'ECOMMERCE') {
    const [products, orders, categories] = await Promise.all([
      prisma.product.count({ where: { businessId } }),
      prisma.order.count({ where: { businessId } }),
      prisma.productCategory.count({ where: { businessId } }),
    ]);
    if (products > 0) hidden.products = products;
    if (orders > 0) hidden.orders = orders;
    if (categories > 0) hidden.categories = categories;
  }

  let customerImpact = null;
  if (currentVertical === 'APPOINTMENT') {
    customerImpact = 'Customers will no longer be able to book appointments. Existing booking links will show "no longer available".';
  } else if (currentVertical === 'ECOMMERCE') {
    customerImpact = 'Your shop pages will no longer be accessible. Existing product links and the cart will redirect to the homepage.';
  }

  return {
    currentVertical,
    targetVertical,
    hidden,
    gained: GAINED_BY_TARGET[targetVertical] || [],
    customerImpact,
    noOp: false,
  };
}

function priceRefForGateway(priceRow, billingCycle, gateway) {
  if (!priceRow) return null;
  if (gateway === 'STRIPE') {
    return billingCycle === 'YEARLY'
      ? priceRow.stripePriceIdAnnual || null
      : priceRow.stripePriceIdMonthly || null;
  }
  if (gateway === 'RAZORPAY') {
    return billingCycle === 'YEARLY'
      ? priceRow.razorpayPlanIdAnnual || null
      : priceRow.razorpayPlanIdMonthly || null;
  }
  return getPriceIdForBillingCycle(priceRow, billingCycle);
}

function gatewayConfigured(gateway) {
  if (gateway === 'STRIPE') return Boolean(process.env.STRIPE_SECRET_KEY);
  if (gateway === 'RAZORPAY') return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  return isPaddleConfigured();
}

function subscriptionRefForGateway(subscription, gateway) {
  if (gateway === 'STRIPE') return subscription?.stripeSubscriptionId || null;
  if (gateway === 'RAZORPAY') return subscription?.razorpaySubscriptionId || null;
  return subscription?.paddleSubscriptionId || null;
}

function prorationModeFor({ gateway, direction, subscription }) {
  if (gateway === 'STRIPE') return stripeProrationBehaviorFor({ direction, subscription });
  if (gateway === 'RAZORPAY') return `schedule_${razorpayScheduleChangeAtFor({ direction })}`;
  return paddleProrationModeFor({ direction, subscription });
}

function priceRefMissingCode(gateway) {
  if (gateway === 'STRIPE') return 'STRIPE_PRICE_ID_MISSING';
  if (gateway === 'RAZORPAY') return 'RAZORPAY_PLAN_ID_MISSING';
  return 'PADDLE_PRICE_ID_MISSING';
}

function gatewayLabel(gateway) {
  if (gateway === 'STRIPE') return 'Stripe';
  if (gateway === 'RAZORPAY') return 'Razorpay';
  return 'Paddle';
}

async function buildBillingChangePreview({
  businessId,
  tierId = null,
  tierSlug = null,
  targetVertical = null,
  billingCycle = 'MONTHLY',
} = {}) {
  if (!businessId) {
    const err = new Error('businessId is required');
    err.status = 400;
    throw err;
  }
  if (!tierId && !tierSlug) {
    const err = new Error('tierId or tierSlug is required');
    err.status = 400;
    throw err;
  }
  if (!isValidBillingCycle(billingCycle)) {
    const err = new Error('billingCycle must be MONTHLY or YEARLY');
    err.status = 400;
    throw err;
  }

  const [business, subscription, targetTier] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, vertical: true, country: true, billingCountry: true },
    }),
    prisma.subscription.findUnique({
      where: { businessId },
      include: { tier: true },
    }),
    resolveTargetTier({ tierId, tierSlug }),
  ]);

  if (!business) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }
  if (!targetTier || !targetTier.isActive) {
    const err = new Error('Tier not found');
    err.status = 404;
    throw err;
  }

  const currentVertical = resolveVertical(business.vertical);
  const resolvedTargetVertical = targetVertical && VALID_VERTICALS.has(String(targetVertical).toUpperCase())
    ? String(targetVertical).toUpperCase()
    : resolveVertical(targetTier.vertical || currentVertical);

  const blocking = [];
  const warnings = [];
  if (targetTier.isCustomPriced) {
    blocking.push({
      code: 'CUSTOM_PRICED_PLAN',
      message: `${targetTier.name} is managed by support and cannot be self-served.`,
    });
  }
  if (resolveVertical(targetTier.vertical) !== resolvedTargetVertical) {
    blocking.push({
      code: 'TARGET_TIER_VERTICAL_MISMATCH',
      message: 'The selected plan belongs to a different business type than the requested target.',
      tierVertical: resolveVertical(targetTier.vertical),
      targetVertical: resolvedTargetVertical,
    });
  }
  if (resolvedTargetVertical !== currentVertical) {
    blocking.push({
      code: 'VERTICAL_SWITCH_DISABLED',
      message: 'Business type is locked for this account. Create a new account for another business type, or delete this business and start again.',
      currentVertical,
      targetVertical: resolvedTargetVertical,
    });
  }

  const priceCountry = normalizeCountryCode(business.billingCountry || business.country);
  const priceRecord = await resolveTierPriceRecord({
    tierId: targetTier.id,
    countryCode: priceCountry,
  }).catch(() => null);
  // Honor the gateway the tenant is already subscribed on (an existing Paddle
  // tenant changes plans on Paddle even if their country would route to
  // Razorpay/Stripe). Country routing only applies to a brand-new subscription.
  const gateway = resolveGatewayForChange({ subscription, countryCode: priceCountry });
  const priceId = priceRecord ? priceRefForGateway(priceRecord, billingCycle, gateway) : null;
  const rawAmountMinor = billingCycle === 'YEARLY'
    ? priceRecord?.amountAnnualMinor
    : priceRecord?.amountMonthlyMinor;
  const amountMinor = Number(rawAmountMinor);
  const amountConfigured = Number.isFinite(amountMinor) && amountMinor > 0;
  const targetIsFree = isTrueFreeTier(targetTier);
  const configured = gatewayConfigured(gateway);
  const gatewaySubscriptionRef = subscriptionRefForGateway(subscription, gateway);
  const hasGatewaySubscription = Boolean(gatewaySubscriptionRef);
  const hasPaddleSubscription = Boolean(subscription?.paddleSubscriptionId);
  const activeGateway = activeGatewayFromSubscription(subscription);
  const paidTarget = !targetIsFree && !targetTier.isCustomPriced;
  const direction = classifyPlanChange({
    currentTier: subscription?.tier,
    targetTier,
    currentBillingCycle: subscription?.billingCycle,
    targetBillingCycle: billingCycle,
  });
  const timing = changeTiming(direction);

  if (paidTarget && !priceRecord) {
    blocking.push({
      code: 'PRICE_RECORD_MISSING',
      message: `No price record is configured for ${targetTier.name}.`,
    });
  } else if (paidTarget) {
    if (!priceRecord.currencyCode) {
      blocking.push({
        code: 'PRICE_CURRENCY_MISSING',
        message: `Currency is missing for ${targetTier.name}.`,
      });
    }
    if (!amountConfigured) {
      blocking.push({
        code: 'PRICE_AMOUNT_INVALID',
        message: `${targetTier.name} has an invalid ${billingCycle.toLowerCase()} amount.`,
      });
    }
  }
  if (paidTarget && !priceId) {
    blocking.push({
      code: priceRefMissingCode(gateway),
      message: `${gatewayLabel(gateway)} ${billingCycle.toLowerCase()} price reference is missing for ${targetTier.name}.`,
    });
  }
  if (paidTarget && !configured) {
    blocking.push({
      code: `${gateway}_NOT_CONFIGURED`,
      message: `${gatewayLabel(gateway)} is not configured on the backend.`,
    });
  }
  const migrationBlock = gatewayMigrationBlock({
    subscription,
    targetGateway: gateway,
    paidTarget,
  });
  if (migrationBlock) blocking.push(migrationBlock);

  const impact = await buildVerticalImpact({
    businessId,
    currentVertical,
    targetVertical: resolvedTargetVertical,
  });
  const prorationBillingMode = prorationModeFor({
    gateway,
    direction,
    subscription,
  });

  return {
    current: {
      vertical: currentVertical,
      tier: serializeTier(subscription?.tier),
      billingCycle: subscription?.billingCycle || null,
      status: subscription?.status || null,
      gateway,
      activeGateway,
      hasGatewaySubscription,
      hasPaddleSubscription,
      pendingChange: subscription?.pendingTierSlug ? {
        tierSlug: subscription.pendingTierSlug,
        billingCycle: subscription.pendingBillingCycle,
        effectiveAt: subscription.pendingChangeEffectiveAt,
        vertical: subscription.pendingVertical ? resolveVertical(subscription.pendingVertical) : null,
      } : subscription?.pendingVertical ? {
        tierSlug: null,
        billingCycle: null,
        effectiveAt: null,
        vertical: resolveVertical(subscription.pendingVertical),
      } : null,
    },
    target: {
      vertical: resolvedTargetVertical,
      tier: serializeTier(targetTier),
      billingCycle,
      direction,
    },
    impact,
    money: {
      gateway,
      gatewayConfigured: configured,
      paddleConfigured: gateway === 'PADDLE' ? configured : isPaddleConfigured(),
      priceIdConfigured: Boolean(priceId),
      priceId: priceId || null,
      currencyCode: priceRecord?.currencyCode || null,
      expectedAmountMinor: Number.isFinite(amountMinor) ? amountMinor : null,
      expectedAmountSource: priceRecord?.countryCode ? 'country_override' : (priceRecord ? 'base_price' : 'missing'),
      targetIsFree,
      paidTarget,
      activeGateway,
      gatewayMigrationRequired: Boolean(migrationBlock),
      requiresCheckout: paidTarget && !hasGatewaySubscription,
      willUpdateGatewaySubscription: paidTarget && hasGatewaySubscription,
      willUpdatePaddleSubscription: paidTarget && gateway === 'PADDLE' && hasGatewaySubscription,
      willScheduleFreeDowngrade: targetIsFree && hasGatewaySubscription,
      willScheduleDowngrade: paidTarget && hasGatewaySubscription && timing === 'period_end',
      changeTiming: timing,
      prorationBillingMode,
      taxMode: gateway === 'PADDLE' ? 'paddle_merchant_of_record' : 'sitepresso_merchant_of_record',
      finalAmountNote: timing === 'period_end'
        ? `${gatewayLabel(gateway)} keeps the current plan for this period; the selected plan starts at renewal with no immediate charge or credit.`
        : `${gatewayLabel(gateway)} confirms final tax, localized amount, and any prorated difference at checkout or subscription update.`,
    },
    warnings,
    blocking,
    safeToCommit: blocking.length === 0,
  };
}

module.exports = {
  buildBillingChangePreview,
  buildVerticalImpact,
};
