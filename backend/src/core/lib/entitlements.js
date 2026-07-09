const prisma = require('./prisma');
const { isPaidTier } = require('./featuresCatalog');
const { launchFreePlanGrantsAllowed } = require('./launchPeriod');

const ACTIVE_STATUSES = new Set(['ACTIVE', 'TRIALING', 'CANCEL_SCHEDULED']);
const UNLIMITED = Number.POSITIVE_INFINITY;

const FALLBACK_LIMITS = Object.freeze({
  staff_count: {
    free: 1,
    solo: 1,
    starter: 2,
    professional: 10,
    business: UNLIMITED,
    custom: UNLIMITED,
    'static-free': 1,
    'static-starter': 1,
    'static-professional': 2,
    'static-business': 5,
    'static-custom': UNLIMITED,
    // Commerce staff seats exclude the owner/admin account. Staff seats cover
    // invited operators, pickers, riders, managers, and contractor rider rows.
    'ecom-free': 1,
    'ecom-starter': 5,
    'ecom-professional': 10,
    'ecom-business': 30,
    'ecom-custom': UNLIMITED,
  },
  pages_count: {
    free: 1,
    solo: 3,
    starter: 5,
    professional: 20,
    business: UNLIMITED,
    custom: UNLIMITED,
    'static-free': 1,
    'static-starter': 5,
    'static-professional': UNLIMITED,
    'static-business': 50,
    'static-custom': UNLIMITED,
    'ecom-free': 5,
    'ecom-starter': 10,
    'ecom-professional': 25,
    'ecom-business': 50,
    'ecom-custom': UNLIMITED,
  },
  products_count: {
    free: 0,
    solo: 0,
    starter: 0,
    professional: 0,
    business: 0,
    custom: 0,
    'static-free': 0,
    'static-starter': 0,
    'static-professional': 0,
    'static-business': 0,
    'static-custom': 0,
    'ecom-free': 100,
    'ecom-starter': 1000,
    'ecom-professional': 10000,
    'ecom-business': UNLIMITED,
    'ecom-custom': UNLIMITED,
  },
  fulfillment_locations_count: {
    free: 1,
    solo: 1,
    starter: 1,
    professional: 1,
    business: UNLIMITED,
    custom: UNLIMITED,
    'static-free': 1,
    'static-starter': 1,
    'static-professional': 1,
    'static-business': 5,
    'static-custom': UNLIMITED,
    'ecom-free': 10,
    'ecom-starter': 10,
    'ecom-professional': 10,
    'ecom-business': 10,
    'ecom-custom': UNLIMITED,
  },
  branches_count: {
    free: 1,
    solo: 1,
    starter: 1,
    professional: 1,
    business: UNLIMITED,
    custom: UNLIMITED,
    'static-free': 1,
    'static-starter': 1,
    'static-professional': 1,
    'static-business': 5,
    'static-custom': UNLIMITED,
    'ecom-free': 1,
    'ecom-starter': 1,
    'ecom-professional': 1,
    'ecom-business': 3,
    'ecom-custom': UNLIMITED,
  },
  locations_count: {
    free: 1,
    solo: 1,
    starter: 1,
    professional: 1,
    business: UNLIMITED,
    custom: UNLIMITED,
    'static-free': 1,
    'static-starter': 1,
    'static-professional': 1,
    'static-business': 5,
    'static-custom': UNLIMITED,
    'ecom-free': 10,
    'ecom-starter': 10,
    'ecom-professional': 10,
    'ecom-business': 3,
    'ecom-custom': UNLIMITED,
  },
  bookings_per_month: {
    free: 10,
    solo: 50,
    starter: UNLIMITED,
    professional: UNLIMITED,
    business: UNLIMITED,
    custom: UNLIMITED,
  },
});

// Fallback for BOOLEAN entitlements when a tier has no TierFeature row seeded.
// Default is OFF; only the tiers listed here get the feature. api_access is a
// Business/Agency-tier gate per the pricing strategy.
const FALLBACK_BOOLEANS = Object.freeze({
  api_access: {
    business: true, custom: true, agency: true,
    'ecom-business': true, 'ecom-custom': true, 'ecom-agency': true,
    'static-business': true, 'static-custom': true, 'static-agency': true,
  },
  // Advanced SEO (per-page meta overrides, 301/302 redirects, bulk CSV) is a
  // Professional+ feature. Basic SEO (sitemap, robots, site-wide meta) stays
  // free for every tier.
  advanced_seo: {
    professional: true, business: true, custom: true, agency: true,
    'static-professional': true, 'static-business': true, 'static-custom': true, 'static-agency': true,
    'ecom-professional': true, 'ecom-business': true, 'ecom-custom': true, 'ecom-agency': true,
  },
  // AI content generation (product descriptions, SEO meta, blog outlines) is a
  // Professional+ feature — it spends real model tokens per call, so it sits
  // above the free/starter tiers alongside advanced_seo.
  ai_generation: {
    professional: true, business: true, custom: true, agency: true,
    'static-professional': true, 'static-business': true, 'static-custom': true, 'static-agency': true,
    'ecom-professional': true, 'ecom-business': true, 'ecom-custom': true, 'ecom-agency': true,
  },

  // ── Bundled add-on products (AapkaChat / AapkaPOS / WMS) ───────────────────
  // Per docs/PRODUCT_BUNDLING_ROADMAP.md: each product is a plan-gated add-on,
  // available on PAID plans only (the entry tier of each vertical is excluded).
  // CAPACITY scales by SEATS (staff_count) — these booleans only decide whether
  // the product is available to the tenant at all; the per-person seat count
  // (assertNumericLimit('staff_count')) governs how many agents/operators/users.
  //
  // Live chat — all verticals, Starter+ (entry tiers solo / static-free /
  // ecom-free excluded).
  live_chat: {
    starter: true, professional: true, business: true, custom: true, agency: true,
    'static-starter': true, 'static-professional': true, 'static-business': true, 'static-custom': true, 'static-agency': true,
    'ecom-starter': true, 'ecom-professional': true, 'ecom-business': true, 'ecom-custom': true, 'ecom-agency': true,
  },
  // Point of sale — ECOMMERCE only, paid (ecom-free entry excluded).
  pos: {
    'ecom-starter': true, 'ecom-professional': true, 'ecom-business': true, 'ecom-custom': true, 'ecom-agency': true,
  },
  // Warehouse management — ECOMMERCE top tiers only (warehouse ops).
  wms: {
    'ecom-professional': true, 'ecom-business': true, 'ecom-custom': true, 'ecom-agency': true,
  },
});

const KEY_ALIASES = Object.freeze({
  staff: 'staff_count',
  staff_members: 'staff_count',
  pages: 'pages_count',
  page_count: 'pages_count',
  products: 'products_count',
  product_count: 'products_count',
  bookings: 'bookings_per_month',
  branches: 'branches_count',
  branch_count: 'branches_count',
  locations: 'locations_count',
  location_count: 'locations_count',
  fulfillment_locations: 'fulfillment_locations_count',
  fulfillment_location_count: 'fulfillment_locations_count',
});

function canonicalKey(key) {
  const normalized = String(key || '').trim();
  return KEY_ALIASES[normalized] || normalized;
}

function future(value, now = new Date()) {
  return value && new Date(value).getTime() > now.getTime();
}

// Unified with the single billing state machine: a tenant may use paid features
// while ACTIVE or in GRACE; ONBOARDING (never paid) and EXPIRED (lapsed past
// grace) are denied (the caller turns this into a 402). Previously this was a
// near-duplicate of billingAccess.js that could drift out of sync.
function subscriptionGrantsAccess(subscription, now = new Date()) {
  const { billingAccessState } = require('./billingAccess');
  const state = billingAccessState({ subscription }, now).state;
  return state === 'active' || state === 'grace';
}

function parseTierFeatureLimit(row) {
  if (!row) return null;
  const type = String(row.featureType || '').toUpperCase();
  const value = String(row.featureValue || '').trim().toLowerCase();
  if (type === 'UNLIMITED' || value === 'unlimited' || value === '-1') return UNLIMITED;
  if (type !== 'NUMERIC') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function fallbackLimitForTier(tier, key) {
  if (!tier) return null;
  const slug = String(tier.slug || '').toLowerCase();
  const bySlug = FALLBACK_LIMITS[key] || {};
  if (Object.prototype.hasOwnProperty.call(bySlug, slug)) return bySlug[slug];
  if (key === 'staff_count' && Number.isFinite(Number(tier.includedStaff))) {
    return Number(tier.includedStaff);
  }
  if (key === 'branches_count' && Number.isFinite(Number(tier.includedBranches))) {
    return Number(tier.includedBranches);
  }
  return null;
}

async function getBusinessSubscriptionWithFeatures(businessId) {
  if (!prisma.subscription?.findUnique) return null;
  return prisma.subscription.findUnique({
    where: { businessId },
    include: {
      tier: {
        include: {
          tierFeatures: true,
        },
      },
    },
  });
}

async function numericEntitlement(businessId, key) {
  const normalizedKey = canonicalKey(key);
  const subscription = await getBusinessSubscriptionWithFeatures(businessId);
  const tier = subscription?.tier || null;
  const accessAllowed = subscriptionGrantsAccess(subscription);

  const row = tier?.tierFeatures?.find((feature) => feature.featureKey === normalizedKey);
  const featureLimit = parseTierFeatureLimit(row);
  const fallback = fallbackLimitForTier(tier, normalizedKey);
  const rawLimit = featureLimit == null ? fallback : featureLimit;
  const limit = rawLimit == null ? UNLIMITED : rawLimit;

  return {
    key: normalizedKey,
    tierSlug: tier?.slug || null,
    limit,
    unlimited: limit === UNLIMITED,
    accessAllowed,
    source: featureLimit == null ? 'fallback' : 'tier_feature',
  };
}

function limitLabel(limit) {
  if (limit === UNLIMITED) return 'unlimited';
  return String(limit);
}

async function assertNumericLimit({ businessId, key, currentCount, increment = 1, label = 'items' }) {
  const entitlement = await numericEntitlement(businessId, key);
  if (!entitlement.accessAllowed) {
    const err = new Error('Your plan needs renewal before you can create more items.');
    err.status = 402;
    err.code = 'billing_access_required';
    err.entitlement = entitlement;
    throw err;
  }

  if (entitlement.unlimited) return entitlement;

  const current = Number(currentCount) || 0;
  const next = current + (Number(increment) || 1);
  if (next > entitlement.limit) {
    const err = new Error(`Your plan includes ${limitLabel(entitlement.limit)} ${label}. Upgrade in Billing & Plan before adding more.`);
    err.status = 409;
    err.code = 'plan_limit_reached';
    err.entitlement = entitlement;
    err.currentCount = current;
    throw err;
  }

  return entitlement;
}

async function billableStaffSeatCount(businessId) {
  if (!businessId) return 0;
  const [staffUsers, contractorRiders] = await Promise.all([
    prisma.user.count({
      where: {
        businessId,
        isActive: true,
        role: 'STAFF',
      },
    }),
    prisma.ecomRider?.count
      ? prisma.ecomRider.count({
        where: {
          businessId,
          userId: null,
          status: { not: 'DEPARTED' },
        },
      })
      : Promise.resolve(0),
  ]);
  return staffUsers + contractorRiders;
}

function parseTierFeatureBoolean(row) {
  if (!row) return null;
  const v = String(row.featureValue || '').trim().toLowerCase();
  if (['true', '1', 'yes', 'unlimited'].includes(v)) return true;
  if (['false', '0', 'no', ''].includes(v)) return false;
  return null;
}

function fallbackBooleanForTier(tier, key) {
  if (!tier) return false;
  const slug = String(tier.slug || '').toLowerCase();
  return Boolean((FALLBACK_BOOLEANS[key] || {})[slug]);
}

// ── Sellable ADD-ONS (granted independently of the base tier) ─────────────────
// Some boolean entitlements are purchasable add-ons that layer on top of ANY base
// plan (e.g. Talent Acquisition). They are granted by EITHER an active per-product
// add-on subscription (PaddleBillingSubscription with the mapped productKind) OR a
// manual grant in Business.featureFlags.addOns.<key> (comp / trial / super-admin) —
// so a tenant on the free base plan can still hold the add-on. Maps the entitlement
// key → billing productKind.
const ADDON_PRODUCT_KIND = Object.freeze({
  talent_acquisition: 'TALENT',
});
const ADDON_ACTIVE_STATUSES = Object.freeze(['active', 'trialing', 'grace', 'past_due']);

async function hasActiveAddOn(businessId, key) {
  if (!businessId) return false;
  // 1) manual grant / trial via featureFlags.addOns.<key>
  try {
    const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { featureFlags: true } });
    const flags = biz?.featureFlags;
    if (flags && typeof flags === 'object' && flags.addOns && flags.addOns[key] === true) return true;
  } catch (_e) { /* featureFlags is best-effort */ }
  // 2) an active per-product add-on subscription
  const productKind = ADDON_PRODUCT_KIND[key];
  if (productKind && prisma.paddleBillingSubscription?.findFirst) {
    try {
      const sub = await prisma.paddleBillingSubscription.findFirst({
        where: { businessId, productKind, status: { in: [...ADDON_ACTIVE_STATUSES] } },
        select: { id: true },
      });
      if (sub) return true;
    } catch (_e) { /* billing table optional */ }
  }
  return false;
}

// Resolve a BOOLEAN tier entitlement (e.g. api_access, white_label). Combines
// the TierFeature row (if seeded) with a fallback map, gated by active access.
// Purchasable ADD-ONS additionally OR-in an active add-on grant (see above), which
// is self-standing — it does not require the BASE plan to be current.
async function booleanEntitlement(businessId, key) {
  const normalizedKey = canonicalKey(key);
  const subscription = await getBusinessSubscriptionWithFeatures(businessId);
  const tier = subscription?.tier || null;
  const accessAllowed = subscriptionGrantsAccess(subscription);

  const row = tier?.tierFeatures?.find((feature) => feature.featureKey === normalizedKey);
  const fromRow = parseTierFeatureBoolean(row);
  const enabledByTier = fromRow == null ? fallbackBooleanForTier(tier, normalizedKey) : fromRow;

  const addOnGranted = ADDON_PRODUCT_KIND[normalizedKey] ? await hasActiveAddOn(businessId, normalizedKey) : false;

  return {
    key: normalizedKey,
    tierSlug: tier?.slug || null,
    // add-on grant is self-standing; tier grant still requires base-plan access.
    enabled: addOnGranted || (Boolean(enabledByTier) && accessAllowed),
    accessAllowed,
    source: addOnGranted ? 'add_on' : (fromRow == null ? 'fallback' : 'tier_feature'),
  };
}

// Throw if a BOOLEAN feature is not in the plan (403) or the plan needs renewal (402).
async function assertBooleanFeature({ businessId, key, label = 'This feature' }) {
  const entitlement = await booleanEntitlement(businessId, key);
  if (!entitlement.accessAllowed) {
    const err = new Error('Your plan needs renewal before you can use this feature.');
    err.status = 402;
    err.code = 'billing_access_required';
    err.entitlement = entitlement;
    throw err;
  }
  if (!entitlement.enabled) {
    const err = new Error(`${label} is available on the Business plan and above. Upgrade to enable it.`);
    err.status = 403;
    err.code = 'feature_not_in_plan';
    err.entitlement = entitlement;
    throw err;
  }
  return entitlement;
}

function currentUtcMonthRange(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

async function assertMonthlyBookingLimit({ businessId, increment = 1, now = new Date() }) {
  const { start, end } = currentUtcMonthRange(now);
  const currentCount = await prisma.appointment.count({
    where: {
      businessId,
      createdAt: { gte: start, lt: end },
    },
  });
  return assertNumericLimit({
    businessId,
    key: 'bookings_per_month',
    currentCount,
    increment,
    label: 'bookings this month',
  });
}

// The HR add-on entitlement map for the frontend (nav gating + BillingTab). Keyed
// by entitlement key → { enabled, source }. Cheap: one query per add-on key.
const HR_ADDON_KEYS = Object.freeze(['talent_acquisition']);
async function hrEntitlements(businessId) {
  const out = {};
  for (const key of HR_ADDON_KEYS) {
    // eslint-disable-next-line no-await-in-loop
    const e = await booleanEntitlement(businessId, key);
    out[key] = { enabled: e.enabled, source: e.source };
  }
  return out;
}

module.exports = {
  UNLIMITED,
  assertBooleanFeature,
  assertMonthlyBookingLimit,
  assertNumericLimit,
  billableStaffSeatCount,
  booleanEntitlement,
  canonicalKey,
  currentUtcMonthRange,
  hasActiveAddOn,
  hrEntitlements,
  HR_ADDON_KEYS,
  ADDON_PRODUCT_KIND,
  limitLabel,
  numericEntitlement,
  subscriptionGrantsAccess,
};
