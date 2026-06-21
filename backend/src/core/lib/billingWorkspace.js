const prisma = require('./prisma');
const {
  getPaddleEnvironment,
  getPaddleSubscription,
  isPaddleConfigured,
  listPaddleTransactions,
} = require('./paddle');
const {
  buildBillingContext,
  extractAfterCursor,
  serializeBillingTransaction,
} = require('./paddleBillingViews');
const { resolveVertical } = require('./vertical');
const trial = require('./trial');
const {
  PLAN_FAMILY_LABELS,
  PLAN_FAMILY_ORDER,
  familyRank,
  planFamilyKeyForTier,
} = require('./planCatalog');

const VERTICAL_WINDOWS = [
  {
    key: 'APPOINTMENT',
    label: 'Appointments',
    internalLabel: 'Appointment business',
    summary: 'Services, staff, schedules, customer booking, reminders, and CRM.',
  },
  {
    key: 'ECOMMERCE',
    label: 'Commerce',
    internalLabel: 'Ecommerce business',
    summary: 'Products, inventory, cart, checkout, orders, fulfillment, and store operations.',
  },
  {
    key: 'STATIC',
    label: 'Website',
    internalLabel: 'Static website',
    summary: 'Pages, SEO, contact forms, brand presence, and content publishing.',
  },
];

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Free/cancelled subscriptions store currentPeriodEnd = FOREVER() (~100 years
// out, see subscriptionBilling.js) as a "no expiry" sentinel. That must never
// surface as a real "next billing" date (it rendered as e.g. "Apr 25, 2126").
// Treat anything more than 50 years in the future as "no renewal" → null.
function realBillingDate(value) {
  const stamp = iso(value);
  if (!stamp) return null;
  const FIFTY_YEARS_MS = 50 * 365 * 24 * 60 * 60 * 1000;
  return new Date(stamp).getTime() - Date.now() > FIFTY_YEARS_MS ? null : stamp;
}

function normalizeCountry(country) {
  const normalized = String(country || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function priceRecordForTier(tier, priceRows, countryCode) {
  const tierPrices = priceRows.filter((row) => row.tierId === tier.id);
  return (
    (countryCode ? tierPrices.find((row) => row.countryCode === countryCode) : null)
    || tierPrices.find((row) => row.countryCode == null)
    || null
  );
}

function serializePrice(priceRow, countryAssignment) {
  if (!priceRow) {
    return {
      configured: false,
      source: 'missing',
      currencyCode: null,
      amountMonthlyMinor: null,
      amountAnnualMinor: null,
      monthlyPriceIdConfigured: false,
      annualPriceIdConfigured: false,
    };
  }

  const isCountryOverride = Boolean(priceRow.countryCode);
  const multiplier = isCountryOverride ? 1 : Number(countryAssignment?.zone?.multiplier || 1);
  return {
    configured: true,
    source: isCountryOverride ? 'country_override' : (countryAssignment ? 'base_price_with_zone_context' : 'base_price'),
    countryCode: priceRow.countryCode || null,
    currencyCode: priceRow.currencyCode,
    amountMonthlyMinor: priceRow.amountMonthlyMinor,
    amountAnnualMinor: priceRow.amountAnnualMinor,
    displayMonthlyMinor: Math.round(Number(priceRow.amountMonthlyMinor || 0) * multiplier),
    displayAnnualMinor: Math.round(Number(priceRow.amountAnnualMinor || 0) * multiplier),
    multiplier,
    monthlyPriceIdConfigured: Boolean(priceRow.paddlePriceIdMonthly),
    annualPriceIdConfigured: Boolean(priceRow.paddlePriceIdAnnual),
  };
}

function serializePlanVariant(tier, priceRows, countryAssignment) {
  const familyKey = planFamilyKeyForTier(tier);
  const price = serializePrice(priceRecordForTier(tier, priceRows, countryAssignment?.countryCode), countryAssignment);

  return {
    id: tier.id,
    slug: tier.slug,
    vertical: resolveVertical(tier.vertical),
    familyKey,
    familyLabel: PLAN_FAMILY_LABELS[familyKey] || tier.name,
    familyRank: familyRank(familyKey),
    name: tier.name,
    tagline: tier.tagline || '',
    description: tier.description || '',
    badge: tier.badge || null,
    features: Array.isArray(tier.features) ? tier.features : [],
    includedStaff: tier.includedStaff || null,
    sortOrder: Number(tier.sortOrder || 0),
    isCustomPriced: Boolean(tier.isCustomPriced),
    trialDays: tier.trialDays || null,
    price,
  };
}

function buildPlanCatalog(tiers, priceRows, countryAssignment, currentVertical, currentTierSlug) {
  const variants = tiers.map((tier) => serializePlanVariant(tier, priceRows, countryAssignment));
  const variantsByVertical = new Map();

  for (const variant of variants) {
    if (!variantsByVertical.has(variant.vertical)) variantsByVertical.set(variant.vertical, []);
    variantsByVertical.get(variant.vertical).push(variant);
  }

  const planFamilies = PLAN_FAMILY_ORDER.map((familyKey) => {
    const familyVariants = variants
      .filter((variant) => variant.familyKey === familyKey)
      .sort((a, b) => a.vertical.localeCompare(b.vertical));
    return {
      key: familyKey,
      label: PLAN_FAMILY_LABELS[familyKey],
      rank: familyRank(familyKey),
      variants: familyVariants.map((variant) => ({
        vertical: variant.vertical,
        slug: variant.slug,
        name: variant.name,
        isCustomPriced: variant.isCustomPriced,
      })),
    };
  }).filter((family) => family.variants.length > 0);

  const currentVariant = variants.find((variant) => variant.slug === currentTierSlug) || null;
  const currentFamilyKey = currentVariant?.familyKey || null;

  const verticalWindows = VERTICAL_WINDOWS.map((window) => {
    const plans = (variantsByVertical.get(window.key) || [])
      .slice()
      .sort((a, b) => a.familyRank - b.familyRank || a.sortOrder - b.sortOrder);
    const equivalentPlan = currentFamilyKey
      ? plans.find((plan) => plan.familyKey === currentFamilyKey) || null
      : null;
    const entryPlan = plans.find((plan) => !plan.isCustomPriced) || plans[0] || null;

    return {
      ...window,
      current: window.key === currentVertical,
      plans,
      recommendedPlanSlug: (equivalentPlan || entryPlan)?.slug || null,
      recommendedFamilyKey: (equivalentPlan || entryPlan)?.familyKey || null,
      hasCurrentFamilyEquivalent: Boolean(equivalentPlan),
    };
  });

  return {
    planFamilies,
    variants,
    currentFamilyKey,
    verticalWindows,
  };
}

function serializeBusiness(business) {
  if (!business) return null;
  return {
    id: business.id,
    name: business.name,
    slug: business.slug,
    vertical: resolveVertical(business.vertical),
    country: business.country || null,
    billingCountry: business.billingCountry || null,
    defaultCurrency: business.defaultCurrency || null,
    category: business.category || null,
    createdAt: iso(business.createdAt),
    updatedAt: iso(business.updatedAt),
  };
}

function serializeBillingProfile(business) {
  if (!business) return null;
  return {
    purchaserType: business.billingPurchaserType || 'INDIVIDUAL',
    businessName: business.billingBusinessName || '',
    contactName: business.billingContactName || '',
    email: business.billingEmail || '',
    taxId: business.billingTaxId || '',
    addressLine1: business.billingAddressLine1 || '',
    addressLine2: business.billingAddressLine2 || '',
    city: business.billingCity || '',
    state: business.billingState || '',
    postalCode: business.billingPostalCode || '',
    country: business.billingCountry || '',
  };
}

function serializeSubscription(subscription, pendingTier) {
  if (!subscription) return null;
  return {
    id: subscription.id,
    status: subscription.status,
    billingCycle: subscription.billingCycle,
    tier: subscription.tier ? {
      id: subscription.tier.id,
      slug: subscription.tier.slug,
      name: subscription.tier.name,
      vertical: resolveVertical(subscription.tier.vertical),
      familyKey: planFamilyKeyForTier(subscription.tier),
      sortOrder: Number(subscription.tier.sortOrder || 0),
    } : null,
    currentPeriodEnd: iso(subscription.currentPeriodEnd),
    pendingChange: subscription.pendingTierSlug ? {
      tierSlug: subscription.pendingTierSlug,
      tier: pendingTier ? {
        id: pendingTier.id,
        slug: pendingTier.slug,
        name: pendingTier.name,
        vertical: resolveVertical(pendingTier.vertical),
        familyKey: planFamilyKeyForTier(pendingTier),
      } : null,
      billingCycle: subscription.pendingBillingCycle || null,
      effectiveAt: iso(subscription.pendingChangeEffectiveAt),
      vertical: subscription.pendingVertical ? resolveVertical(subscription.pendingVertical) : null,
    } : subscription.pendingVertical ? {
      tierSlug: null,
      tier: null,
      billingCycle: null,
      effectiveAt: null,
      vertical: resolveVertical(subscription.pendingVertical),
    } : null,
    trial: trial.summarise(subscription),
    pastDue: {
      since: iso(subscription.pastDueSince),
      accessGraceUntil: iso(subscription.accessGraceUntil),
    },
    paddle: {
      customerId: subscription.paddleCustomerId || null,
      subscriptionId: subscription.paddleSubscriptionId || null,
      transactionId: subscription.paddleTransactionId || null,
      lastEventId: subscription.lastPaddleEventId || null,
      lastEventAt: iso(subscription.lastPaddleEventAt),
    },
    createdAt: iso(subscription.createdAt),
    updatedAt: iso(subscription.updatedAt),
  };
}

function event(id, type, source, occurredAt, title, summary, metadata = {}) {
  return {
    id: String(id || `${source}:${type}:${occurredAt || Date.now()}`),
    type,
    source,
    occurredAt: iso(occurredAt) || new Date(0).toISOString(),
    title,
    summary,
    metadata,
  };
}

function timelineFromLocalRows({
  subscription,
  couponRedemptions,
  pricingAuditLogs,
  webhookEvents,
  billingPurchases,
  paymentAttempts,
  adjustmentLedger,
  messagingTopupGrants,
}) {
  const events = [];

  if (subscription?.createdAt) {
    events.push(event(
      `subscription:${subscription.id}:created`,
      'subscription.created',
      'sitepresso',
      subscription.createdAt,
      'Subscription record created',
      subscription.tier?.name ? `Initial plan record created on ${subscription.tier.name}.` : 'Initial subscription record created.',
      { tierSlug: subscription.tier?.slug || null }
    ));
  }

  if (subscription?.pendingTierSlug) {
    events.push(event(
      `subscription:${subscription.id}:pending-change`,
      'subscription.pending_change',
      'sitepresso',
      subscription.pendingChangeEffectiveAt || subscription.updatedAt,
      'Plan change pending',
      `Pending change to ${subscription.pendingTierSlug}${subscription.pendingBillingCycle ? ` (${subscription.pendingBillingCycle.toLowerCase()})` : ''}.`,
      {
        pendingTierSlug: subscription.pendingTierSlug,
        pendingBillingCycle: subscription.pendingBillingCycle || null,
        effectiveAt: iso(subscription.pendingChangeEffectiveAt),
        pendingVertical: subscription.pendingVertical || null,
      }
    ));
  } else if (subscription?.pendingVertical) {
    events.push(event(
      `subscription:${subscription.id}:pending-vertical`,
      'subscription.pending_vertical',
      'sitepresso',
      subscription.updatedAt,
      'Business type change needs review',
      `A legacy request tried to switch this account to ${resolveVertical(subscription.pendingVertical)}. Business type changes are now handled by creating a separate account.`,
      { pendingVertical: resolveVertical(subscription.pendingVertical) }
    ));
  }

  for (const redemption of couponRedemptions) {
    const coupon = redemption.coupon || {};
    events.push(event(
      `coupon:${redemption.id}`,
      'coupon.redeemed',
      'sitepresso',
      redemption.createdAt,
      'Subscription coupon redeemed',
      coupon.code ? `Coupon ${coupon.code} was applied.` : 'A subscription coupon was applied.',
      {
        couponCode: coupon.code || null,
        benefitType: coupon.benefitType || redemption.benefitSnapshot?.benefitType || null,
        appliedFreeDays: redemption.appliedFreeDays || null,
      }
    ));
  }

  for (const purchase of billingPurchases || []) {
    events.push(event(
      `billing-purchase:${purchase.id}`,
      'billing.purchase',
      'sitepresso',
      purchase.updatedAt || purchase.createdAt,
      `${purchase.productKind || 'Billing'} purchase`,
      `${String(purchase.status || 'recorded').replace(/_/g, ' ').toLowerCase()}${purchase.actualTotalMinor != null ? ` for ${purchase.actualCurrencyCode || purchase.expectedCurrencyCode || ''} ${purchase.actualTotalMinor}` : ''}.`,
      {
        purchaseId: purchase.id,
        productKind: purchase.productKind,
        status: purchase.status,
        expectedPriceId: purchase.expectedPriceId || null,
        expectedAmountMinor: purchase.expectedAmountMinor,
        expectedCurrencyCode: purchase.expectedCurrencyCode,
        actualTotalMinor: purchase.actualTotalMinor,
        actualTaxMinor: purchase.actualTaxMinor,
        actualCurrencyCode: purchase.actualCurrencyCode,
        paddleTransactionId: purchase.paddleTransactionId || null,
        paddleSubscriptionId: purchase.paddleSubscriptionId || null,
        invoiceNumber: purchase.invoiceNumber || null,
      }
    ));
  }

  for (const attempt of paymentAttempts || []) {
    events.push(event(
      `payment-attempt:${attempt.id}`,
      'billing.payment_attempt',
      'sitepresso',
      attempt.createdAt,
      'Payment attempt',
      `${String(attempt.status || 'recorded').replace(/_/g, ' ').toLowerCase()}${attempt.amountMinor != null ? ` for ${attempt.currencyCode || ''} ${attempt.amountMinor}` : ''}.`,
      {
        attemptId: attempt.id,
        purchaseId: attempt.purchaseId || null,
        status: attempt.status,
        amountMinor: attempt.amountMinor,
        currencyCode: attempt.currencyCode,
        paddleTransactionId: attempt.paddleTransactionId || null,
        failureCode: attempt.failureCode || null,
      }
    ));
  }

  for (const adjustment of adjustmentLedger || []) {
    events.push(event(
      `adjustment-ledger:${adjustment.id}`,
      'billing.adjustment',
      'sitepresso',
      adjustment.updatedAt || adjustment.createdAt,
      'Billing adjustment',
      `${String(adjustment.action || 'adjustment').replace(/_/g, ' ')} ${String(adjustment.status || 'recorded').replace(/_/g, ' ')}${adjustment.amountMinor != null ? ` for ${adjustment.currencyCode || ''} ${adjustment.amountMinor}` : ''}.`,
      {
        adjustmentId: adjustment.id,
        paddleAdjustmentId: adjustment.paddleAdjustmentId || null,
        action: adjustment.action,
        status: adjustment.status,
        reason: adjustment.reason || null,
        amountMinor: adjustment.amountMinor,
        currencyCode: adjustment.currencyCode,
        paddleTransactionId: adjustment.paddleTransactionId || null,
        paddleSubscriptionId: adjustment.paddleSubscriptionId || null,
      }
    ));
  }

  for (const grant of messagingTopupGrants || []) {
    events.push(event(
      `messaging-topup-grant:${grant.id}`,
      'messaging.topup_granted',
      'sitepresso',
      grant.createdAt,
      'Messaging credit granted',
      `SMS/WhatsApp credit of USD ${grant.amountUsd} was added for ${grant.cycle}.`,
      {
        grantId: grant.id,
        purchaseId: grant.purchaseId || null,
        amountUsd: grant.amountUsd,
        currencyCode: grant.currencyCode || 'USD',
        cycle: grant.cycle,
        paddleTransactionId: grant.paddleTransactionId || null,
      }
    ));
  }

  for (const audit of pricingAuditLogs) {
    const note = audit.note || audit.newValue?.event || audit.action;
    events.push(event(
      `pricing-audit:${audit.id}`,
      'pricing.audit',
      'sitepresso',
      audit.createdAt,
      'Pricing/subscription audit',
      String(note || 'Pricing audit record created.'),
      {
        action: audit.action,
        changedBy: audit.changedBy || null,
        oldValue: audit.oldValue || null,
        newValue: audit.newValue || null,
      }
    ));
  }

  for (const webhook of webhookEvents) {
    const eventType = webhook.eventType || 'Paddle webhook';
    const isAdjustment = String(eventType).startsWith('adjustment.');
    events.push(event(
      `webhook:${webhook.eventId || webhook.id}`,
      isAdjustment ? 'paddle.adjustment' : 'paddle.webhook',
      'paddle',
      webhook.occurredAt || webhook.createdAt,
      isAdjustment ? 'Paddle adjustment recorded' : eventType,
      `Paddle ${eventType} is ${String(webhook.status || '').toLowerCase() || 'recorded'}.`,
      {
        eventId: webhook.eventId,
        status: webhook.status,
        objectId: webhook.objectId || null,
        attempts: webhook.attempts || 0,
      }
    ));
  }

  return events.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
}

function minutesSince(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
}

function diagnostic(code, severity, title, detail, metadata = {}) {
  return { code, severity, title, detail, metadata };
}

function buildSupportDiagnostics({ business, subscription, catalog, webhookEvents, paddle }) {
  const checks = [];
  const currentVertical = resolveVertical(business?.vertical);
  const tierVertical = subscription?.tier?.vertical ? resolveVertical(subscription.tier.vertical) : null;

  if (tierVertical && tierVertical !== currentVertical) {
    checks.push(diagnostic(
      'PLAN_VERTICAL_MISMATCH',
      'critical',
      'Plan and business type differ',
      'The active tier belongs to a different product window than the business.',
      { currentVertical, tierVertical, tierSlug: subscription.tier?.slug || null }
    ));
  }

  if (subscription?.pendingTierSlug || subscription?.pendingVertical) {
    const ageMinutes = minutesSince(subscription.updatedAt || subscription.createdAt);
    if (ageMinutes != null && ageMinutes >= 30) {
      checks.push(diagnostic(
        'PENDING_CHANGE_STUCK',
        'warning',
        'Pending change has not completed',
        'A plan change or legacy business-type switch is still pending after 30 minutes. Run billing reconciliation or clear the legacy switch with support.',
        {
          pendingTierSlug: subscription.pendingTierSlug || null,
          pendingVertical: subscription.pendingVertical || null,
          ageMinutes,
        }
      ));
    }
  }

  const failedWebhooks = (webhookEvents || []).filter((event) => String(event.status || '').toUpperCase() === 'FAILED');
  if (failedWebhooks.length > 0) {
    checks.push(diagnostic(
      'FAILED_PADDLE_WEBHOOKS',
      'critical',
      'Failed Paddle webhook events',
      'One or more Paddle webhook events failed processing and may need replay or manual reconciliation.',
      {
        count: failedWebhooks.length,
        latestEventId: failedWebhooks[0]?.eventId || null,
        latestEventType: failedWebhooks[0]?.eventType || null,
      }
    ));
  }

  if (subscription?.paddleTransactionId && !subscription?.paddleSubscriptionId && !subscription?.pendingTierSlug) {
    checks.push(diagnostic(
      'CHECKOUT_ORPHANED',
      'warning',
      'Checkout transaction without active subscription',
      'A Paddle transaction is stored locally but no Paddle subscription is attached yet.',
      { transactionId: subscription.paddleTransactionId }
    ));
  }

  const currentWindow = catalog?.verticalWindows?.find((window) => window.current);
  const currentPlan = currentWindow?.plans?.find((plan) => plan.slug === subscription?.tier?.slug);
  if (currentPlan?.price?.configured && !currentPlan.isCustomPriced) {
    if (!currentPlan.price.monthlyPriceIdConfigured || !currentPlan.price.annualPriceIdConfigured) {
      checks.push(diagnostic(
        'PADDLE_PRICE_IDS_INCOMPLETE',
        'warning',
        'Paddle price IDs incomplete',
        'The active plan has a base price but one or more Paddle price IDs are missing.',
        {
          tierSlug: currentPlan.slug,
          monthly: currentPlan.price.monthlyPriceIdConfigured,
          annual: currentPlan.price.annualPriceIdConfigured,
        }
      ));
    }
  }

  if (paddle?.error) {
    checks.push(diagnostic(
      'PADDLE_LOOKUP_FAILED',
      'warning',
      'Paddle lookup failed',
      'The billing workspace could not fetch live Paddle transactions.',
      { error: paddle.error }
    ));
  }

  return {
    generatedAt: new Date().toISOString(),
    status: checks.some((check) => check.severity === 'critical')
      ? 'attention_required'
      : checks.length > 0 ? 'watch' : 'healthy',
    checks,
  };
}

function buildWarnings({ business, subscription, catalog }) {
  const warnings = [];
  const currentVertical = resolveVertical(business?.vertical);
  const currentTierVertical = subscription?.tier?.vertical ? resolveVertical(subscription.tier.vertical) : null;

  if (currentTierVertical && currentTierVertical !== currentVertical) {
    warnings.push({
      code: 'PLAN_VERTICAL_MISMATCH',
      severity: 'high',
      message: 'The current plan belongs to a different business type than this workspace.',
      currentVertical,
      tierVertical: currentTierVertical,
    });
  }

  if (subscription?.pendingTierSlug) {
    warnings.push({
      code: 'PENDING_PLAN_CHANGE',
      severity: 'info',
      message: 'A plan change is already pending confirmation or the next billing period.',
      pendingTierSlug: subscription.pendingTierSlug,
      effectiveAt: iso(subscription.pendingChangeEffectiveAt),
      pendingVertical: subscription.pendingVertical || null,
    });
  } else if (subscription?.pendingVertical) {
    warnings.push({
      code: 'PENDING_VERTICAL_CHANGE',
      severity: 'info',
      message: 'A legacy business type switch is pending review. Business type is locked for this account.',
      pendingVertical: resolveVertical(subscription.pendingVertical),
    });
  }

  const currentWindow = catalog.verticalWindows.find((window) => window.current);
  if (currentWindow && !currentWindow.hasCurrentFamilyEquivalent && catalog.currentFamilyKey) {
    warnings.push({
      code: 'NO_EQUIVALENT_PLAN_IN_CURRENT_VERTICAL',
      severity: 'medium',
      message: 'The current plan family does not have a clean equivalent in this business type.',
      currentFamilyKey: catalog.currentFamilyKey,
    });
  }

  return warnings;
}

async function loadPaddleBilling(subscription, businessId, perPage) {
  const configured = isPaddleConfigured();
  const result = {
    configured,
    environment: getPaddleEnvironment(),
    canOpenPortal: Boolean((configured && subscription?.paddleCustomerId) || subscription?.stripeCustomerId),
    overview: {
      collectionMode: null,
      currentPeriodStart: null,
      currentPeriodEnd: realBillingDate(subscription?.currentPeriodEnd),
      nextBilledAt: realBillingDate(subscription?.currentPeriodEnd),
      scheduledChange: null,
    },
    transactions: [],
    pagination: { nextAfter: null },
    error: null,
  };

  if (!configured) return result;

  try {
    if (subscription?.paddleSubscriptionId) {
      const paddleSubscription = await getPaddleSubscription(subscription.paddleSubscriptionId).catch(() => null);
      if (paddleSubscription) {
        result.overview.collectionMode = paddleSubscription.collection_mode || null;
        result.overview.currentPeriodStart = paddleSubscription?.current_billing_period?.starts_at || null;
        result.overview.currentPeriodEnd = paddleSubscription?.current_billing_period?.ends_at || result.overview.currentPeriodEnd;
        result.overview.nextBilledAt = paddleSubscription?.next_billed_at || result.overview.nextBilledAt;
        result.overview.scheduledChange = paddleSubscription?.scheduled_change || null;
      }
    }

    if (!subscription?.paddleCustomerId) return result;

    const { data, meta } = await listPaddleTransactions({
      customer_id: subscription.paddleCustomerId,
      order_by: 'created_at[DESC]',
      per_page: perPage,
    });
    const context = await buildBillingContext(data);
    result.transactions = data
      .map((transaction) => serializeBillingTransaction(transaction, context))
      .filter((transaction) => !transaction.business || transaction.business.id === businessId);
    result.pagination.nextAfter = extractAfterCursor(meta?.pagination?.next);
  } catch (err) {
    result.error = err?.message || 'Could not load live Paddle billing details.';
  }

  return result;
}

async function buildBillingWorkspace({ businessId, transactionLimit = 8, eventLimit = 20 } = {}) {
  if (!businessId) {
    const err = new Error('businessId is required');
    err.status = 400;
    throw err;
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      slug: true,
      vertical: true,
      country: true,
      defaultCurrency: true,
      category: true,
      billingPurchaserType: true,
      billingBusinessName: true,
      billingContactName: true,
      billingEmail: true,
      billingTaxId: true,
      billingAddressLine1: true,
      billingAddressLine2: true,
      billingCity: true,
      billingState: true,
      billingPostalCode: true,
      billingCountry: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!business) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }

  const currentVertical = resolveVertical(business.vertical);
  const countryCode = normalizeCountry(business.billingCountry || business.country);

  const [
    subscription,
    tiers,
    priceRows,
    countryAssignment,
    couponRedemptions,
    pricingAuditLogs,
    webhookEvents,
    billingPurchases,
    paymentAttempts,
    adjustmentLedger,
    messagingTopupGrants,
  ] = await Promise.all([
    prisma.subscription.findUnique({
      where: { businessId },
      include: { tier: true },
    }),
    prisma.pricingTier.findMany({
      where: { isActive: true },
      orderBy: [{ vertical: 'asc' }, { sortOrder: 'asc' }],
    }),
    prisma.tierPrice.findMany({
      where: {
        OR: [
          { countryCode: null },
          ...(countryCode ? [{ countryCode }] : []),
        ],
      },
    }),
    countryCode
      ? prisma.countryZoneAssignment.findUnique({
          where: { countryCode },
          include: { zone: true },
        })
      : Promise.resolve(null),
    prisma.adminCouponRedemption.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: eventLimit,
      include: {
        coupon: {
          select: {
            code: true,
            benefitType: true,
            benefitValue: true,
            benefitUnit: true,
            benefitCurrency: true,
          },
        },
      },
    }),
    prisma.pricingAuditLog.findMany({
      where: { entityType: 'subscription', entityId: businessId },
      orderBy: { createdAt: 'desc' },
      take: eventLimit,
    }),
    prisma.paddleWebhookEvent.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: eventLimit,
    }),
    prisma.billingPurchase
      ? prisma.billingPurchase.findMany({
        where: { businessId },
        orderBy: { updatedAt: 'desc' },
        take: eventLimit,
      })
      : Promise.resolve([]),
    prisma.paymentAttempt
      ? prisma.paymentAttempt.findMany({
        where: { businessId },
        orderBy: { createdAt: 'desc' },
        take: eventLimit,
      })
      : Promise.resolve([]),
    prisma.adjustmentLedger
      ? prisma.adjustmentLedger.findMany({
        where: { businessId },
        orderBy: { updatedAt: 'desc' },
        take: eventLimit,
      })
      : Promise.resolve([]),
    prisma.messagingTopupGrant
      ? prisma.messagingTopupGrant.findMany({
        where: { businessId },
        orderBy: { createdAt: 'desc' },
        take: eventLimit,
      })
      : Promise.resolve([]),
  ]);

  const pendingTier = subscription?.pendingTierSlug
    ? tiers.find((tier) => tier.slug === subscription.pendingTierSlug) || null
    : null;
  const catalog = buildPlanCatalog(
    tiers,
    priceRows,
    countryAssignment,
    currentVertical,
    subscription?.tier?.slug || null
  );
  const paddle = await loadPaddleBilling(subscription, businessId, transactionLimit);
  const localTimeline = timelineFromLocalRows({
    subscription,
    couponRedemptions,
    pricingAuditLogs,
    webhookEvents,
    billingPurchases,
    paymentAttempts,
    adjustmentLedger,
    messagingTopupGrants,
  });
  const transactionEvents = paddle.transactions.map((transaction) => event(
    `paddle-transaction:${transaction.id}`,
    'paddle.transaction',
    'paddle',
    transaction.billedAt || transaction.createdAt,
    'Paddle transaction',
    `${transaction.status.replace(/_/g, ' ')} transaction${transaction.totalMinor != null ? ` for ${transaction.currencyCode || ''} ${transaction.totalMinor}` : ''}.`,
    {
      transactionId: transaction.id,
      status: transaction.status,
      totalMinor: transaction.totalMinor,
      currencyCode: transaction.currencyCode,
      invoiceNumber: transaction.invoiceNumber || null,
      hasInvoice: Boolean(transaction.hasInvoice),
    }
  ));
  const history = [...localTimeline, ...transactionEvents]
    .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))
    .slice(0, eventLimit + transactionLimit);

  const serializedSubscription = serializeSubscription(subscription, pendingTier);
  const warnings = buildWarnings({ business, subscription, catalog });
  const support = buildSupportDiagnostics({
    business,
    subscription,
    catalog,
    webhookEvents,
    paddle,
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    business: serializeBusiness(business),
    billingProfile: serializeBillingProfile(business),
    subscription: serializedSubscription,
    paddle,
    ledger: {
      purchases: billingPurchases,
      paymentAttempts,
      adjustments: adjustmentLedger,
      messagingTopupGrants,
    },
    catalog,
    workspace: {
      currentVertical,
      currentPlanFamilyKey: catalog.currentFamilyKey,
      warnings,
      supportStatus: support.status,
      recommendedPrimaryAction: subscription?.pendingTierSlug
        ? 'review_pending_change'
        : subscription?.status === 'PAST_DUE'
          ? 'update_payment_method'
          : 'manage_plan',
    },
    history: {
      events: history,
      transactions: paddle.transactions,
      pagination: paddle.pagination,
    },
    support,
  };
}

module.exports = {
  buildBillingWorkspace,
  buildPlanCatalog,
  planFamilyKeyForTier,
};
