const prisma = require('./prisma');
const {
  pendingEntitlementPatch,
} = require('./billingPlanChangePolicy');

const FREE_TIER_SLUG = 'free';

function FOREVER() {
  return new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
}

function normalizeCountryCode(countryCode) {
  const normalized = String(countryCode || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function billingCycleFromInterval(interval) {
  const normalized = String(interval || '').toLowerCase();
  if (normalized === 'year') return 'YEARLY';
  return normalized === 'month' ? 'MONTHLY' : null;
}

function mapPaddleStatusToLocal(status) {
  switch (String(status || '').toLowerCase()) {
    case 'trialing': return 'TRIALING';
    case 'past_due': return 'PAST_DUE';
    case 'paused': return 'PAUSED';
    case 'canceled': return 'CANCELLED';
    case 'active': return 'ACTIVE';
    default:
      return 'EXPIRED';
  }
}

function getPastDueGraceDays() {
  // 7-day dunning grace: a lapsed paid tenant stays in GRACE (full access + a
  // "pay now" countdown) for a week before going EXPIRED (storefront dark +
  // dashboard locked to Billing/export). Override with the env var.
  const parsed = Number.parseInt(process.env.SUBSCRIPTION_PAST_DUE_GRACE_DAYS || '7', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 7;
  return Math.min(parsed, 30);
}

function pastDueAccessPatch({ existing, eventAt, paddleStatus }) {
  if (paddleStatus !== 'past_due') {
    return {
      pastDueSince: null,
      accessGraceUntil: null,
    };
  }

  const pastDueSince = existing?.pastDueSince
    ? new Date(existing.pastDueSince)
    : (eventAt || new Date());
  const graceDays = getPastDueGraceDays();
  const accessGraceUntil = graceDays > 0
    ? new Date(pastDueSince.getTime() + graceDays * 24 * 60 * 60 * 1000)
    : null;

  return {
    pastDueSince,
    accessGraceUntil,
  };
}

async function getFreeTier() {
  return prisma.pricingTier.findUnique({ where: { slug: FREE_TIER_SLUG } });
}

// Each vertical has its OWN free tier (free=APPOINTMENT, static-free=STATIC,
// ecom-free=ECOMMERCE). Assigning the wrong-vertical free tier triggers the
// PLAN_VERTICAL_MISMATCH warning, so always resolve by the business's vertical.
// Keep IN SYNC with featuresCatalog.js FREE_TIER_SLUG_SET — both must classify
// the same slugs as non-paid, or isPaidTier (features) and the billing isPaid
// checks would disagree for a given tier. 'trial' is defensive (no such tier
// exists today) but included in both for consistency. (B21)
const FREE_TIER_SLUGS = new Set(['free', 'static-free', 'ecom-free', 'trial']);
const FREE_TIER_BY_VERTICAL = { APPOINTMENT: 'free', STATIC: 'static-free', ECOMMERCE: 'ecom-free' };
function freeTierSlugForVertical(vertical) {
  return FREE_TIER_BY_VERTICAL[String(vertical || '').toUpperCase()] || FREE_TIER_SLUG;
}
async function getFreeTierForVertical(vertical) {
  const slug = freeTierSlugForVertical(vertical);
  return (await prisma.pricingTier.findUnique({ where: { slug } }))
    || prisma.pricingTier.findUnique({ where: { slug: FREE_TIER_SLUG } });
}
// Resolve the free tier that matches a business's vertical, so a cancel/lapse
// downgrade lands on free / static-free / ecom-free — not always APPOINTMENT
// 'free' (which would trigger PLAN_VERTICAL_MISMATCH for ECOM/STATIC tenants).
async function getBusinessVertical(businessId) {
  if (!prisma.business?.findUnique) return null;
  try {
    const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { vertical: true } });
    return biz?.vertical || null;
  } catch {
    return null; // never block a sync on the vertical lookup — fall back to generic free
  }
}

async function hydrateSubscription(subscription) {
  if (!subscription) return null;

  // Gateway trial mirror state — derived from trialEndsAt + trialConvertedAt
  // columns. Frontend uses this to render the trial countdown banner.
  // See backend/src/core/lib/trial.js for the semantics.
  const trial = require('./trial');
  const trialState = trial.summarise(subscription);

  if (!subscription.pendingTierSlug) return { ...subscription, trial: trialState };

  const pendingTier = await prisma.pricingTier.findUnique({
    where: { slug: subscription.pendingTierSlug },
    select: { id: true, slug: true, name: true },
  });
  return { ...subscription, pendingTier, trial: trialState };
}

async function getBusinessSubscription(businessId) {
  const subscription = await prisma.subscription.findUnique({
    where: { businessId },
    include: { tier: true },
  });
  return hydrateSubscription(subscription);
}

async function ensureBusinessSubscription(businessId, fallbackTierId = null) {
  const existing = await prisma.subscription.findUnique({ where: { businessId } });
  if (existing) return existing;

  let tierId = fallbackTierId;
  if (!tierId) {
    const freeTier = await getFreeTier();
    if (!freeTier) throw new Error('Free tier is missing. Run prisma/seeds/pricing.seed.js first.');
    tierId = freeTier.id;
  }

  return prisma.subscription.create({
    data: {
      businessId,
      tierId,
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      currentPeriodEnd: FOREVER(),
      theme: 'default',
      seatsUsed: 1,
    },
  });
}

async function resolveTierPriceRecord({ tierId, countryCode }) {
  const { resolvePresentmentCurrency, isSupportedBillingCurrency } = require('./billing/gatewayRouter');
  const normalizedCountry = normalizeCountryCode(countryCode);
  if (normalizedCountry) {
    const localRow = await prisma.tierPrice.findFirst({
      where: { tierId, countryCode: normalizedCountry },
    });
    // Only honour an exact-country row if it's in a currency we actually bill in
    // (INR/NZD/GBP/EUR/USD). A legacy row in an unsupported currency (e.g. PKR for
    // PK, BDT for BD) is inert — fall through to the country's supported currency.
    if (localRow && isSupportedBillingCurrency(localRow.currencyCode)) return localRow;

    // Currency fallback: map the country to its presentment currency and use the
    // canonical price for THAT currency. This makes the catalog effectively
    // 5-currency — every eurozone country resolves to the EUR row, every RoW
    // country to USD — without needing a per-country row.
    const currency = resolvePresentmentCurrency(normalizedCountry);
    if (currency) {
      const currencyRow = await prisma.tierPrice.findFirst({
        where: { tierId, currencyCode: currency },
      });
      if (currencyRow) return currencyRow;
    }
  }

  const globalRow = await prisma.tierPrice.findFirst({
    where: { tierId, countryCode: null },
  });
  if (globalRow) return globalRow;

  // Last resort: any price row that has at least one Paddle price ID.
  // Covers sandbox setups where only a few country prices are seeded.
  return prisma.tierPrice.findFirst({
    where: {
      tierId,
      OR: [
        { paddlePriceIdMonthly: { not: null } },
        { paddlePriceIdAnnual: { not: null } },
      ],
    },
    orderBy: { id: 'asc' },
  });
}

function getPriceIdForBillingCycle(priceRow, billingCycle) {
  if (!priceRow) return null;
  return billingCycle === 'YEARLY'
    ? priceRow.paddlePriceIdAnnual || null
    : priceRow.paddlePriceIdMonthly || null;
}

async function findTierForPaddlePriceId(priceId) {
  if (!priceId) return null;

  const price = await prisma.tierPrice.findFirst({
    where: {
      OR: [
        { paddlePriceIdMonthly: priceId },
        { paddlePriceIdAnnual: priceId },
      ],
    },
    include: { tier: true },
  });

  if (!price) return null;
  return {
    tier: price.tier,
    price,
    billingCycle: price.paddlePriceIdAnnual === priceId ? 'YEARLY' : 'MONTHLY',
  };
}

// Stripe counterpart of findTierForPaddlePriceId — reverse-lookup a tier by its
// New Zealand Stripe price id.
async function findTierForStripePriceId(priceId) {
  if (!priceId) return null;
  const price = await prisma.tierPrice.findFirst({
    where: { OR: [{ stripePriceIdMonthly: priceId }, { stripePriceIdAnnual: priceId }] },
    include: { tier: true },
  });
  if (!price) return null;
  return {
    tier: price.tier,
    price,
    billingCycle: price.stripePriceIdAnnual === priceId ? 'YEARLY' : 'MONTHLY',
  };
}

// Razorpay counterpart — reverse-lookup a tier by its Razorpay plan id (IN/INR).
async function findTierForRazorpayPlanId(planId) {
  if (!planId) return null;
  const price = await prisma.tierPrice.findFirst({
    where: { OR: [{ razorpayPlanIdMonthly: planId }, { razorpayPlanIdAnnual: planId }] },
    include: { tier: true },
  });
  if (!price) return null;
  return {
    tier: price.tier,
    price,
    billingCycle: price.razorpayPlanIdAnnual === planId ? 'YEARLY' : 'MONTHLY',
  };
}

function extractPrimaryPaddlePriceId(paddleSubscription) {
  if (!Array.isArray(paddleSubscription?.items)) return null;
  for (const item of paddleSubscription.items) {
    if (item?.price?.id) return item.price.id;
    if (item?.price_id) return item.price_id;
  }
  return null;
}

function resolveScheduledChangeDate(paddleSubscription) {
  return paddleSubscription?.scheduled_change?.effective_at
    || paddleSubscription?.scheduled_change?.resume_at
    || paddleSubscription?.next_billed_at
    || paddleSubscription?.current_billing_period?.ends_at
    || null;
}

function parsePaddleEventDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function paddleSubscriptionUpdatedAt(paddleSubscription) {
  return parsePaddleEventDate(
    paddleSubscription?.updated_at
    || paddleSubscription?.updatedAt
    || paddleSubscription?.created_at
    || paddleSubscription?.createdAt
  );
}

function isStalePaddleSubscriptionEvent(existing, eventAt) {
  if (!existing?.lastPaddleEventAt || !eventAt) return false;
  return eventAt.getTime() < new Date(existing.lastPaddleEventAt).getTime();
}

async function syncBusinessSubscriptionFromPaddle({
  businessId,
  paddleSubscription,
  paddleTransactionId = null,
  paddleEventOccurredAt = null,
  paddleEventId = null,
  targetVertical = null,
}) {
  const existing = await ensureBusinessSubscription(businessId);
  const eventAt = parsePaddleEventDate(paddleEventOccurredAt) || paddleSubscriptionUpdatedAt(paddleSubscription);
  if (isStalePaddleSubscriptionEvent(existing, eventAt)) {
    return hydrateSubscription({ ...existing, stalePaddleEventIgnored: true });
  }
  let vertical = await getBusinessVertical(businessId); // for vertical-correct free tier (B4)
  // Apply a pending vertical change carried on the transaction instead of
  // silently dropping it (the controller passes targetVertical but the signature
  // ignored it). Idempotent — only writes when it actually differs. Latent today
  // (cross-vertical changes are blocked at selectPlan). (B13)
  if (targetVertical && String(targetVertical).toUpperCase() !== String(vertical || '').toUpperCase()) {
    const v = String(targetVertical).toUpperCase();
    await prisma.business.update({ where: { id: businessId }, data: { vertical: v } }).catch((e) => console.error('[paddle sync] vertical change failed:', e?.message || e));
    vertical = v;
  }
  const paddleStatus = String(paddleSubscription?.status || '').toLowerCase();
  const paddleEventPatch = eventAt
    ? {
        lastPaddleEventAt: eventAt,
        ...(paddleEventId ? { lastPaddleEventId: paddleEventId } : {}),
      }
    : (paddleEventId ? { lastPaddleEventId: paddleEventId } : {});

  if (paddleStatus === 'canceled') {
    const freeTier = await getFreeTierForVertical(vertical);
    if (!freeTier) throw new Error('Free tier is missing. Run prisma/seeds/pricing.seed.js first.');

    const updated = await prisma.subscription.update({
      where: { businessId },
      data: {
        tierId: freeTier.id,
        status: 'ACTIVE',
        billingCycle: 'MONTHLY',
        currentPeriodEnd: FOREVER(),
        paddleCustomerId: paddleSubscription?.customer_id || existing.paddleCustomerId || null,
        paddleSubscriptionId: null,
        // Clear every gateway subscription id on downgrade-to-free, not just the
        // event's own gateway — a stale cross-gateway id would otherwise leave the
        // tenant looking like they still have a live sub elsewhere. (B16)
        stripeSubscriptionId: null,
        razorpaySubscriptionId: null,
        paddleTransactionId: paddleTransactionId || existing.paddleTransactionId || null,
        pendingTierSlug: null,
        pendingBillingCycle: null,
        pendingChangeEffectiveAt: null,
        pendingVertical: null,
        pastDueSince: null,
        accessGraceUntil: null,
        ...paddleEventPatch,
      },
      include: { tier: true },
    });

    return hydrateSubscription(updated);
  }

  const matched = await findTierForPaddlePriceId(extractPrimaryPaddlePriceId(paddleSubscription));
  const scheduledAction = String(paddleSubscription?.scheduled_change?.action || '').toLowerCase();
  const scheduledChangeAt = resolveScheduledChangeDate(paddleSubscription);
  const isPaidPaddleSubscription = matched?.tier?.slug && !FREE_TIER_SLUGS.has(matched.tier.slug);
  const isEntitlingPaddleStatus = ['active', 'trialing'].includes(paddleStatus);
  const shouldMarkTrialConverted = isPaidPaddleSubscription
    && paddleStatus === 'active'
    && !existing.trialConvertedAt;
  const trialPeriodStartsAt = parsePaddleEventDate(
    paddleSubscription?.current_billing_period?.starts_at
    || paddleSubscription?.created_at
    || paddleSubscription?.createdAt
  );
  const trialPeriodEndsAt = parsePaddleEventDate(
    paddleSubscription?.current_billing_period?.ends_at
    || paddleSubscription?.next_billed_at
  );
  const trialPatch = paddleStatus === 'trialing' && isPaidPaddleSubscription
    ? {
        trialPlanSlug: matched.tier.slug,
        trialStartedAt: trialPeriodStartsAt || existing.trialStartedAt || eventAt || new Date(),
        trialEndsAt: trialPeriodEndsAt || existing.trialEndsAt || null,
        trialConvertedAt: null,
      }
    : shouldMarkTrialConverted
      ? { trialConvertedAt: new Date() }
      : {};
  // F10: keep the PAID tier during a past_due dunning grace window so a transient
  // card failure doesn't instantly lock out a paying customer. Grace expiry is
  // enforced by the scheduler (expirePastDueGraceSubscriptions). Default grace is
  // 7 days (SUBSCRIPTION_PAST_DUE_GRACE_DAYS); set it to 0 for the old behaviour,
  // an immediate downgrade to free at sync time.
  const graceState = pastDueAccessPatch({ existing, eventAt, paddleStatus });
  const graceActive = paddleStatus === 'past_due'
    && graceState.accessGraceUntil
    && new Date(graceState.accessGraceUntil).getTime() > Date.now();
  let tierId = matched?.tier?.id || existing.tierId;
  if (isPaidPaddleSubscription && !isEntitlingPaddleStatus && !graceActive) {
    const freeTier = await getFreeTierForVertical(vertical);
    if (!freeTier) throw new Error('Free tier is missing. Run prisma/seeds/pricing.seed.js first.');
    tierId = freeTier.id;
  }

  const proposedBillingCycle = matched?.billingCycle
    || billingCycleFromInterval(paddleSubscription?.billing_cycle?.interval)
    || existing.billingCycle;
  const entitlement = scheduledAction === 'cancel'
    ? null
    : pendingEntitlementPatch({
        existing,
        matched,
        proposedTierId: tierId,
        proposedBillingCycle,
      });

  const updated = await prisma.subscription.update({
    where: { businessId },
    data: {
      tierId: entitlement?.tierId || tierId,
      status: scheduledAction === 'cancel' && isEntitlingPaddleStatus
        ? 'CANCEL_SCHEDULED'
        : mapPaddleStatusToLocal(paddleStatus),
      billingCycle: entitlement?.billingCycle || proposedBillingCycle,
      currentPeriodEnd: paddleSubscription?.current_billing_period?.ends_at
        ? new Date(paddleSubscription.current_billing_period.ends_at)
        : existing.currentPeriodEnd,
      paddleCustomerId: paddleSubscription?.customer_id || existing.paddleCustomerId || null,
      paddleSubscriptionId: paddleSubscription?.id || existing.paddleSubscriptionId || null,
      paddleTransactionId: paddleTransactionId || existing.paddleTransactionId || null,
      pendingTierSlug: scheduledAction === 'cancel' ? freeTierSlugForVertical(vertical) : (entitlement?.pendingTierSlug ?? null),
      pendingBillingCycle: scheduledAction === 'cancel' ? 'MONTHLY' : (entitlement?.pendingBillingCycle ?? null),
      pendingChangeEffectiveAt: scheduledAction === 'cancel' && scheduledChangeAt
        ? new Date(scheduledChangeAt)
        : (entitlement?.pendingChangeEffectiveAt ?? null),
      pendingVertical: scheduledAction === 'cancel' ? null : (entitlement?.pendingVertical ?? null),
      // Stamp the first real activation (never cleared) so the state machine can
      // tell a lapsed-but-once-paid tenant from a never-paid placeholder.
      activatedAt: existing.activatedAt ?? (isEntitlingPaddleStatus ? (eventAt || new Date()) : null),
      ...graceState,
      ...trialPatch,
      ...paddleEventPatch,
    },
    include: { tier: true },
  });

  return hydrateSubscription(updated);
}

// Gateway-specific id columns for the Subscription update (Stripe vs Razorpay).
function gatewayIdColumns(gw, normalized, existing, subId) {
  if (gw === 'RAZORPAY') {
    return {
      razorpayCustomerId: normalized.gatewayCustomerId || existing.razorpayCustomerId || null,
      razorpaySubscriptionId: subId,
    };
  }
  return {
    stripeCustomerId: normalized.gatewayCustomerId || existing.stripeCustomerId || null,
    stripeSubscriptionId: subId,
  };
}

// syncBusinessSubscriptionFromGatewayEvent — applies a NORMALIZED gateway
// subscription event (stripeGateway/razorpayGateway.normalizeEvent, kind
// 'subscription_change') to the local Subscription, reusing the SAME internal
// lifecycle rules as Paddle: trial mirror, past-due dunning grace, canceled →
// free downgrade. The normalized event carries our internal status AND which
// gateway it came from, so this is fully gateway-agnostic. lastPaddleEventAt/Id
// double as the generic last-gateway-event markers.
async function syncBusinessSubscriptionFromGatewayEvent({ businessId, normalized, eventAt = null, eventId = null }) {
  const gw = String(normalized?.gateway || 'STRIPE').toUpperCase();
  const existing = await ensureBusinessSubscription(businessId);
  const at = parsePaddleEventDate(eventAt);
  if (isStalePaddleSubscriptionEvent(existing, at)) {
    return hydrateSubscription({ ...existing, stalePaddleEventIgnored: true });
  }

  const vertical = await getBusinessVertical(businessId); // for vertical-correct free tier (B4)
  const status = String(normalized?.internalStatus || '').toUpperCase();
  const eventPatch = at
    ? { lastPaddleEventAt: at, ...(eventId ? { lastPaddleEventId: eventId } : {}) }
    : (eventId ? { lastPaddleEventId: eventId } : {});

  // Unknown/incomplete status (e.g. Razorpay 'created', Stripe 'incomplete') —
  // record the event marker but don't touch entitlements.
  if (!['TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELLED'].includes(status)) {
    if (!at && !eventId) return hydrateSubscription(existing);
    const touched = await prisma.subscription.update({
      where: { businessId }, data: eventPatch, include: { tier: true },
    });
    return hydrateSubscription(touched);
  }

  if (status === 'CANCELLED') {
    const freeTier = await getFreeTierForVertical(vertical);
    if (!freeTier) throw new Error('Free tier is missing. Run prisma/seeds/pricing.seed.js first.');
    const updated = await prisma.subscription.update({
      where: { businessId },
      data: {
        tierId: freeTier.id,
        status: 'ACTIVE',
        billingCycle: 'MONTHLY',
        currentPeriodEnd: FOREVER(),
        gateway: gw,
        ...gatewayIdColumns(gw, normalized, existing, null),
        // Clear every gateway subscription id on downgrade-to-free, not just the
        // event's own gateway (B16).
        paddleSubscriptionId: null,
        stripeSubscriptionId: null,
        razorpaySubscriptionId: null,
        pendingTierSlug: null,
        pendingBillingCycle: null,
        pendingChangeEffectiveAt: null,
        pendingVertical: null,
        pastDueSince: null,
        accessGraceUntil: null,
        ...eventPatch,
      },
      include: { tier: true },
    });
    return hydrateSubscription(updated);
  }

  const matched = await (gw === 'RAZORPAY' ? findTierForRazorpayPlanId : findTierForStripePriceId)(normalized?.priceRef);
  const isPaid = Boolean(matched?.tier?.slug && !FREE_TIER_SLUGS.has(matched.tier.slug));
  const entitling = status === 'TRIALING' || status === 'ACTIVE';

  const graceState = pastDueAccessPatch({ existing, eventAt: at, paddleStatus: status === 'PAST_DUE' ? 'past_due' : 'active' });
  const graceActive = status === 'PAST_DUE'
    && graceState.accessGraceUntil
    && new Date(graceState.accessGraceUntil).getTime() > Date.now();

  let tierId = matched?.tier?.id || existing.tierId;
  let downgradedToFree = false;
  if (isPaid && !entitling && !graceActive) {
    const freeTier = await getFreeTierForVertical(vertical);
    if (!freeTier) throw new Error('Free tier is missing. Run prisma/seeds/pricing.seed.js first.');
    tierId = freeTier.id;
    downgradedToFree = true;
  }

  const trialPatch = status === 'TRIALING' && isPaid
    ? {
        trialPlanSlug: matched.tier.slug,
        trialStartedAt: existing.trialStartedAt || at || new Date(),
        trialEndsAt: normalized.currentPeriodEnd || existing.trialEndsAt || null,
        trialConvertedAt: null,
      }
    // Stamp conversion whenever a paid sub is ACTIVE and not yet stamped — aligns
    // with the Paddle twin (which doesn't require a TRIALING predecessor), so a
    // sub that goes straight to ACTIVE is still marked converted. (B20)
    : (isPaid && status === 'ACTIVE' && !existing.trialConvertedAt
        ? { trialConvertedAt: new Date() } : {});

  const existingSubId = gw === 'RAZORPAY' ? existing.razorpaySubscriptionId : existing.stripeSubscriptionId;
  const proposedBillingCycle = matched?.billingCycle || existing.billingCycle;
  const entitlement = pendingEntitlementPatch({
    existing,
    matched,
    proposedTierId: tierId,
    proposedBillingCycle,
  });

  const updated = await prisma.subscription.update({
    where: { businessId },
    data: {
      tierId: entitlement.tierId,
      // When a zero-grace lapse downgrades to free, the tenant is now on a free
      // tier — leaving status PAST_DUE would be misleading and could re-trigger
      // dunning on a free plan. Mark it ACTIVE-on-free. (B19)
      status: downgradedToFree ? 'ACTIVE' : status,
      // First-activation stamp (never cleared) — lets the state machine tell a
      // lapsed once-paid tenant from a never-paid placeholder. See billingAccess.js.
      activatedAt: existing.activatedAt ?? (entitling ? (at || new Date()) : null),
      billingCycle: entitlement.billingCycle,
      currentPeriodEnd: normalized.currentPeriodEnd || existing.currentPeriodEnd,
      gateway: gw,
      ...gatewayIdColumns(gw, normalized, existing, normalized.gatewaySubscriptionId || existingSubId || null),
      pendingTierSlug: entitlement.pendingTierSlug,
      pendingBillingCycle: entitlement.pendingBillingCycle,
      pendingChangeEffectiveAt: entitlement.pendingChangeEffectiveAt,
      pendingVertical: entitlement.pendingVertical,
      ...graceState,
      ...trialPatch,
      ...eventPatch,
    },
    include: { tier: true },
  });
  return hydrateSubscription(updated);
}

// Thin gateway-specific wrappers — the normalized event carries the gateway.
function syncBusinessSubscriptionFromStripe(args) { return syncBusinessSubscriptionFromGatewayEvent(args); }
function syncBusinessSubscriptionFromRazorpay(args) { return syncBusinessSubscriptionFromGatewayEvent(args); }

module.exports = {
  FOREVER,
  FREE_TIER_SLUG,
  FREE_TIER_SLUGS,
  freeTierSlugForVertical,
  getFreeTierForVertical,
  ensureBusinessSubscription,
  extractPrimaryPaddlePriceId,
  findTierForPaddlePriceId,
  findTierForStripePriceId,
  findTierForRazorpayPlanId,
  getBusinessSubscription,
  getPastDueGraceDays,
  getFreeTier,
  getPriceIdForBillingCycle,
  hydrateSubscription,
  mapPaddleStatusToLocal,
  normalizeCountryCode,
  resolveTierPriceRecord,
  syncBusinessSubscriptionFromPaddle,
  syncBusinessSubscriptionFromGatewayEvent,
  syncBusinessSubscriptionFromStripe,
  syncBusinessSubscriptionFromRazorpay,
};
