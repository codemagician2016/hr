const prisma = require('../lib/prisma');
const { ROLES } = require('../lib/roles');
const { resolveVertical } = require('../lib/vertical');
const { healThemeCopy } = require('../lib/themeCopyHeal');
const { routableCustomDomainWhere } = require('../lib/customDomainRouting');
const {
  FEATURE_CATALOG,
  FEATURE_KEYS_FOR_STOREFRONT,
  isPaidTier,
  effectiveEnabled,
  featureAppliesToVertical,
} = require('../lib/featuresCatalog');
const { needsRenewal, billingAccessState } = require('../lib/billingAccess');
const { subscriptionGrantsAccess, numericEntitlement } = require('../lib/entitlements');

const PLATFORM_DOMAIN = (process.env.PLATFORM_DOMAIN || 'sitepresso.com').toLowerCase();

const RESTAURANT_RESERVATIONS_THEME = 'restaurant_reservations';

function subscriptionAllowsPaidFeatures(subscription) {
  const tierSlug = subscription?.tier?.slug || null;
  if (!isPaidTier(tierSlug)) return false;
  return subscriptionGrantsAccess(subscription);
}

// Build the features object the storefront reads. Three-stage resolution:
//   1. catalogDefault — FEATURE_CATALOG[key].defaultOn
//   2. tierOverride   — TierFeature row for (tier, key) wins if present
//   3. adminOverride  — Business.featureFlags[key]
// Rollout + plan gates win first: non-live features are forced OFF, and a
// feature with planRequired:'PAID' is forced OFF on free tiers regardless
// of admin opt-in.
//
// Accepts either a businessId or the resolved business (with .featureFlags +
// .subscription.tier) — callers that already loaded the business avoid an
// extra round-trip.
async function resolveFeatures(input) {
  const business = typeof input === 'object' && input !== null && !Buffer.isBuffer(input)
    ? input
    : null;
  const tierId = business
    ? business?.subscription?.tierId
    : input; // legacy: bare tierId still accepted
  const adminOverrides = (business && typeof business.featureFlags === 'object' && business.featureFlags) || {};
  const paid = business ? subscriptionAllowsPaidFeatures(business.subscription) : false;

  let tierRows = [];
  if (tierId) {
    tierRows = await prisma.tierFeature.findMany({
      where: { tierId, featureKey: { in: FEATURE_KEYS_FOR_STOREFRONT } },
      select: { featureKey: true, featureValue: true, featureType: true },
    });
  }
  const tierMap = new Map();
  for (const row of tierRows) {
    if (row.featureType === 'BOOLEAN') {
      tierMap.set(row.featureKey, String(row.featureValue).toLowerCase() === 'true');
    }
  }

  const out = {};
  const vertical = resolveVertical(business?.vertical);
  for (const key of FEATURE_KEYS_FOR_STOREFRONT) {
    const meta = FEATURE_CATALOG[key];
    if (!featureAppliesToVertical(meta, vertical)) {
      out[key] = false;
      continue;
    }
    const planAllowed = !meta?.planRequired || meta.planRequired !== 'PAID' || paid;
    out[key] = effectiveEnabled({
      catalogDefault: !!meta?.defaultOn,
      tierOverride: tierMap.has(key) ? tierMap.get(key) : undefined,
      adminOverride: adminOverrides[key],
      planAllowed,
      rolloutStatus: meta?.rolloutStatus,
    });
  }
  return out;
}

// Synchronous helper for backend code paths that need a quick yes/no when
// they already have the business loaded (no DB hop). Cannot apply tier
// overrides — for that, use resolveFeatures async. Use this in hot paths
// where the catalog default + admin override is enough (most cases).
function featureEnabled(business, key) {
  const meta = FEATURE_CATALOG[key];
  if (!meta) return false;
  const vertical = resolveVertical(business?.vertical);
  if (!featureAppliesToVertical(meta, vertical)) return false;
  const adminOverride = business && typeof business.featureFlags === 'object' && business.featureFlags
    ? business.featureFlags[key]
    : undefined;
  const planAllowed = !meta.planRequired || meta.planRequired !== 'PAID' || subscriptionAllowsPaidFeatures(business?.subscription);
  return effectiveEnabled({
    catalogDefault: !!meta.defaultOn,
    tierOverride: undefined,
    adminOverride,
    planAllowed,
    rolloutStatus: meta.rolloutStatus,
  });
}

// Returns the per-feature settings object the storefront can consume to
// configure UI bits (e.g. realTimeStock.lowStockThreshold). Sources from
// catalog defaults today; admin-overridable settings layer in here later.
function resolveFeatureSettings() {
  const out = {};
  for (const key of FEATURE_KEYS_FOR_STOREFRONT) {
    const meta = FEATURE_CATALOG[key];
    if (meta?.settings) out[key] = { ...meta.settings };
  }
  return out;
}

function resolveSubscriptionThemeForBusiness(business) {
  const { getThemeForCategory } = require('../lib/categoryTheme');
  const categoryTheme = getThemeForCategory(business?.category);
  if (categoryTheme === RESTAURANT_RESERVATIONS_THEME) return RESTAURANT_RESERVATIONS_THEME;
  return business?.subscription?.theme || categoryTheme || 'other';
}

// Subdomains we reserve for platform infrastructure — never resolve as a tenant
const RESERVED_SUBDOMAINS = new Set([
  'api',
  'www',
  'mail',
  'admin',
  'app',
  'platform',
  'status',
  'docs',
  'help',
  'support',
]);

function normaliseHost(raw) {
  if (typeof raw !== 'string') return '';
  // Strip port + trim + lowercase
  return raw.split(':')[0].trim().toLowerCase();
}

// GET /api/tenant/resolve
// Resolution precedence (first match wins):
//   1. ?slug=<slug>   — used by platform-path admin/staff URLs where the tenant
//      is identified by the URL segment, not the host
//   2. X-Tenant-Slug header — same idea, for non-query clients
//   3. X-Tenant-Host header — subdomain storefront / custom-domain path
//   4. ?host=<host> query param — dev fallback
//
// Returns the business + subscription so the frontend can render the themed
// site for the right tenant.
async function resolve(req, res) {
  const slug = String(req.query.slug || req.get('X-Tenant-Slug') || '').toLowerCase().trim();
  const host = normaliseHost(req.get('X-Tenant-Host') || req.query.host || '');
  if (!slug && !host) {
    return res.status(400).json({ message: 'No tenant specified (slug or host required)' });
  }

  let business = null;
  const platformSuffix = `.${PLATFORM_DOMAIN}`;

  if (slug) {
    if (!/^[a-z0-9-]+$/.test(slug) || RESERVED_SUBDOMAINS.has(slug)) {
      return res.status(404).json({ message: 'Not a tenant' });
    }
    business = await prisma.business.findUnique({
      where: { slug },
      include: {
        subscription: { include: { tier: { select: { name: true, slug: true } } } },
        content: true,
        seoSettings: true,
      },
    });
  } else if (host === PLATFORM_DOMAIN) {
    return res.status(404).json({ message: 'Platform domain is not a tenant' });
  } else if (host.endsWith(platformSuffix)) {
    // Subdomain tenant, e.g. "acme-barber-shop.sitepresso.com"
    const sub = host.slice(0, -platformSuffix.length);
    if (!sub || sub.includes('.') || RESERVED_SUBDOMAINS.has(sub)) {
      return res.status(404).json({ message: 'Not a tenant' });
    }

    business = await prisma.business.findUnique({
      where: { slug: sub },
      include: {
        subscription: { include: { tier: { select: { name: true, slug: true } } } },
        content: true,
        seoSettings: true,
      },
    });
  } else {
    // Verified custom-domain tenant, e.g. "shop.example.com".
    // The public router checks this to pick the correct vertical when the
    // custom host goes through the Worker. Direct Vercel custom domains can
    // reach this app while verification is still pending/failed, so resolve
    // any connected custom domain here and let SEO stay paused until ACTIVE.
    business = await prisma.business.findFirst({
      where: {
        subscription: { is: routableCustomDomainWhere(host) },
      },
      include: {
        subscription: { include: { tier: { select: { name: true, slug: true } } } },
        content: true,
        seoSettings: true,
      },
    });
  }

  if (!business) {
    return res.status(404).json({ message: 'Business not found' });
  }

  // Inactive business — could be suspended by admin OR draft (not yet launched)
  if (!business.isActive) {
    const isSuspended = !!business.suspendedReason;
    const draftFeatures = await resolveFeatures(business);
    const draftThemeKey = resolveSubscriptionThemeForBusiness(business) || 'general_practice';
    const { getAdminVocab: getAdminVocabDraft, getKpiLabels: getKpiLabelsDraft } = require('../lib/themeRegistry');
    return res.status(200).json({
      // Include vertical here so the admin nav can filter to the right
      // tab set immediately after signup (when business is still in
      // draft / pre-launch). Without this, admin defaulted to
      // APPOINTMENT and showed booking-style sidebar to a customer who
      // picked STATIC or ECOMMERCE at onboarding.
      business: {
        id: business.id,
        name: business.name,
        slug: business.slug,
        vertical: resolveVertical(business.vertical),
        defaultCurrency: business.defaultCurrency || null,
        paymentMode: business.paymentMode || 'BOTH',
        pickupEnabled: !!business.pickupEnabled,
        deliveryMode: business.deliveryMode || 'ASAP',
        customDomain: business.subscription?.customDomain || null,
        customDomainVerified: !!business.subscription?.customDomainVerified,
        customDomainStatus: business.subscription?.customDomainStatus || 'NONE',
      },
      suspended: isSuspended,
      draft: !isSuspended, // true = still setting up, hasn't launched yet
      suspendedReason: isSuspended ? business.suspendedReason : null,
      subscription: business.subscription
        ? {
            theme: draftThemeKey,
            themeStyle: business.subscription.themeStyle || 'light',
            themeColors: business.subscription.themeColors || null,
            designPreset: business.subscription.designPreset || null,
            sectionVariants: business.subscription.sectionVariants || null,
          }
        : null,
      theme: draftThemeKey,
      themeVocab: getAdminVocabDraft(draftThemeKey),
      themeKpiLabels: getKpiLabelsDraft(draftThemeKey),
      bookingOpen: false,
      content: {},
      services: [],
      staff: [],
      features: draftFeatures,
    });
  }

  // Billing renew-gate: a paid-tier tenant with no active paid subscription
  // (launch-free over + past grace) is STOPPED until they renew. For the PUBLIC
  // storefront, short-circuit to a renew notice. For the owner DASHBOARD
  // (req._selfContext, set by me()), keep the full payload + a needsRenewal flag
  // so the dashboard can lock itself to Billing & Plan instead of breaking.
  const billing = billingAccessState(business);
  const renewGate = billing.state === 'expired';
  if (renewGate && !req._selfContext) {
    return res.json({
      business: { id: business.id, name: business.name, slug: business.slug },
      needsRenewal: true,
      billingState: billing.state, // 'expired' → storefront shows "pay to reactivate"
      suspended: false,
      draft: false,
    });
  }

  const sub = business.subscription;
  // Theme resolution — HR theme engine. A tenant picks one of 5 fixed styles
  // + one brand color + logo; resolveTenantTheme composes the runtime theme
  // from the subscription's stored brand record. The legacy booking/shop
  // per-profession theme resolvers were deleted with their verticals; HR has
  // a single GENERIC theme model (see reuse-map §8).
  const { resolveTenantTheme } = require('@hr/theme-engine');
  const vertical = resolveVertical(business.vertical);
  const theme = resolveSubscriptionThemeForBusiness(business);
  let storedPrimary;
  if (sub?.themeColors) {
    try { storedPrimary = JSON.parse(sub.themeColors)?.primary; } catch { storedPrimary = undefined; }
  }
  // resolveTenantTheme maps the stored brand → { styleKey, colorKey, primary,
  // logoUrl } onto a composed HR theme object. styleKey falls back to the
  // engine default for unknown/legacy keys, so stale profession themes resolve
  // cleanly instead of throwing.
  const hrTheme = resolveTenantTheme({
    styleKey: sub?.themeStyle || theme,
    primary: storedPrimary,
    logoUrl: sub?.logoUrl || business.logoUrl,
  });
  // Backward-compat payload keys retained for existing storefront/admin
  // readers. HR is a single GENERIC theme, so both surface the same resolved
  // object; non-matching verticals see null exactly as before.
  const bookingTheme = vertical === 'APPOINTMENT' ? hrTheme : null;
  const ecomTheme = vertical === 'ECOMMERCE' ? hrTheme : null;
  const status = sub?.status || 'ACTIVE';
  const bookingOpen = status === 'ACTIVE' || status === 'TRIALING';
  const features = await resolveFeatures(business);

  // Fetch booking resources only for the appointment vertical. STATIC/web
  // tenants store public offerings/team in BusinessContent JSON, and
  // ECOMMERCE tenants use product/order tables, so returning Service/User
  // rows here would leak another vertical's operational data into their
  // storefront payload.
  const [services, staff] = bookingOpen && vertical === 'APPOINTMENT'
    ? await Promise.all([
        prisma.service.findMany({
          where: { businessId: business.id, isActive: true },
          select: { id: true, name: true, description: true, duration: true, price: true, isVirtual: true, requiresPrepayment: true },
          orderBy: { createdAt: 'asc' },
        }),
        // Only staff the owner has chosen to feature (showOnWebsite=true).
        // This decouples "operational staff" from "public-facing team" so
        // temp staff or those who decline a public profile can stay hidden.
        // Booking flow has its own schedule-based filter separately.
        prisma.user.findMany({
          where: {
            businessId: business.id,
            role: { in: [ROLES.STAFF, ROLES.BUSINESS_ADMIN] },
            isActive: true,
            showOnWebsite: true,
          },
          select: {
            id: true, name: true, role: true, avatarUrl: true, subtitle: true, bio: true,
            // Doctor / clinic profile — surfaced on the storefront doctor card.
            registrationNumber: true, qualification: true, speciality: true, specialtyId: true,
            languages: true, experienceYears: true, consultationFee: true,
          },
          orderBy: { createdAt: 'asc' },
        }),
      ])
    : [[], []];

  // Doctor v2 — published reviews + active specialties for the storefront, and
  // the solo-practice signal (explicit Business.featureFlags.solo_mode overrides;
  // else derive from a single featured provider). The bespoke doctor home + the
  // booking wizard read these off the resolved tenant.
  const [reviews, specialties] = bookingOpen && vertical === 'APPOINTMENT'
    ? await Promise.all([
        prisma.review.findMany({
          where: { businessId: business.id, status: 'PUBLISHED' },
          select: { id: true, rating: true, body: true, staffId: true, createdAt: true, customer: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        prisma.specialty.findMany({
          where: { businessId: business.id, isActive: true },
          select: { id: true, name: true, slug: true, description: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
      ])
    : [[], []];
  const ffSolo = (business.featureFlags && typeof business.featureFlags === 'object') ? business.featureFlags.solo_mode : undefined;
  const soloMode = typeof ffSolo === 'boolean' ? ffSolo : (staff.length === 1);

  // Public branch directory — active locations shown by the storefront's
  // (opt-in) Locations section. Managed in the admin Locations tab. Public
  // fields only; ordered primary-first then by name.
  const [locations, deliveryZones] = await Promise.all([
    prisma.businessLocation.findMany({
      where: { businessId: business.id, isActive: true },
      select: {
        id: true, name: true,
        addressLine1: true, addressLine2: true, city: true,
        state: true, postalCode: true, country: true,
        phone: true, isPrimary: true,
      },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
    }),
    vertical === 'ECOMMERCE'
      ? prisma.ecomDeliveryZone.findMany({
        where: { businessId: business.id, isActive: true },
        select: { postcodes: true, polygon: true },
      })
      : Promise.resolve([]),
  ]);
  const activeDeliveryAreaCount = deliveryZones.length;
  // Derive what the storefront should ASK the shopper for, from HOW the seller
  // drew their zones: pincode zones → ask a pincode; radius/polygon zones → ask
  // for their location (GPS/map). Both kinds present → ask either. No zones →
  // NONE (deliver-anywhere flat rate, no prompt). The storefront LocationPrompt
  // renders inputs off this single derived value.
  let hasPincodeZone = false;
  let hasGeoZone = false;
  for (const z of deliveryZones) {
    if (Array.isArray(z.postcodes) && z.postcodes.length > 0) hasPincodeZone = true;
    if (z.polygon) hasGeoZone = true;
  }
  const deliveryLocationInput = hasPincodeZone && hasGeoZone ? 'BOTH'
    : hasPincodeZone ? 'PINCODE'
      : hasGeoZone ? 'LOCATION'
        : 'NONE';

  // Branch entitlement (ECOMMERCE only) — the seller console uses this to gate
  // the "Several branches" selling mode and the location switcher. The first 3
  // ecom plans include a single customer-facing branch (Shopify-style); only
  // ecom-business+ unlock multi-branch. branchesAllowed=null means unlimited.
  const branchEntitlement = vertical === 'ECOMMERCE'
    ? await numericEntitlement(business.id, 'branches_count').catch(() => null)
    : null;
  const branchesAllowed = branchEntitlement
    ? (branchEntitlement.unlimited ? null : branchEntitlement.limit)
    : 1;
  const multiBranchAllowed = branchEntitlement
    ? (branchEntitlement.unlimited || branchEntitlement.limit > 1)
    : false;

  // Theme vocab + KPI labels for the centralized admin shell. Null for
  // themes without per-theme overrides (e.g. legacy/default) — admin
  // then renders the existing i18n labels untouched.
  const { getAdminVocab, getKpiLabels } = require('../lib/themeRegistry');
  const themeVocab = getAdminVocab(theme);
  const themeKpiLabels = getKpiLabels(theme);

  res.json({
    needsRenewal: renewGate,
    // Full billing state for the dashboard: 'onboarding' | 'active' | 'grace' |
    // 'expired'. The admin shell gates on this (redirect onboarding, lock+export
    // on expired, pay-now banner + countdown on grace).
    billingState: billing.state,
    graceUntil: billing.graceUntil || null,
    business: {
      id: business.id,
      name: business.name,
      slug: business.slug,
      slugLastChangedAt: business.slugLastChangedAt,
      description: business.description,
      category: business.category,
      address: business.address,
      state: business.state,
      country: business.country,
      timezone: business.timezone,
      phone: business.phone,
      email: business.email,
      billingPurchaserType: business.billingPurchaserType || 'INDIVIDUAL',
      billingBusinessName: business.billingBusinessName || null,
      billingContactName: business.billingContactName || null,
      billingEmail: business.billingEmail || null,
      billingTaxId: business.billingTaxId || null,
      billingAddressLine1: business.billingAddressLine1 || null,
      billingAddressLine2: business.billingAddressLine2 || null,
      billingCity: business.billingCity || null,
      billingState: business.billingState || null,
      billingPostalCode: business.billingPostalCode || null,
      billingCountry: business.billingCountry || null,
      bookingType: business.bookingType,
      isActive: business.isActive,
      defaultLanguage: business.defaultLanguage || null,
      // Vertical drives admin nav filtering + storefront layout. Default
      // APPOINTMENT for backward compat with all existing tenants.
      vertical,
      // Default currency for the new-product form. Null = UI falls back
      // to "INR" for back-compat with pre-defaultCurrency tenants.
      defaultCurrency: business.defaultCurrency || null,
      // Currency change is rate-limited (90-day cooldown); Store Setup shows
      // the lock using this timestamp. country backs the "use country default"
      // currency hint.
      currencyChangedAt: business.currencyChangedAt || null,
      country: business.country || null,
      // Storefront UX settings — admin-configurable, read by both admin shell and storefront.
      announcementBarEnabled: business.announcementBarEnabled ?? false,
      announcementBarText: business.announcementBarText || null,
      announcementBarBgColor: business.announcementBarBgColor || '#146A39',
      announcementBarTextColor: business.announcementBarTextColor || '#ffffff',
      wishlistEnabled: business.wishlistEnabled !== false,
      wishlistIconType: business.wishlistIconType || 'bookmark',
      categoryGridDisplay: business.categoryGridDisplay || 'main',
      // How many category levels the storefront nav shows (1=top only,
      // 2=+subcategories, 3=full). Drives the "All" mega-menu depth.
      categoryMaxDepth: business.categoryMaxDepth ?? 2,
      paymentMode: business.paymentMode || 'BOTH',
      pickupEnabled: !!business.pickupEnabled,
      deliveryMode: business.deliveryMode || 'ASAP',
      customDomain: sub?.customDomain || null,
      customDomainVerified: !!sub?.customDomainVerified,
      customDomainStatus: sub?.customDomainStatus || 'NONE',
      // ECOMMERCE multi-store / multi-region mode (2026-05-12).
      // Storefront LocationGate reads this to decide whether (and how)
      // to prompt the shopper for a delivery context on first visit.
      multiStoreMode: business.multiStoreMode || 'OFF',
      // Whether this plan can run several customer-facing branches (each with
      // its own stock/prices/delivery), and the included cap. Single-store
      // (Shopify-style) plans get multiBranchAllowed=false / branchesAllowed=1.
      // branchesAllowed=null = unlimited. Drives Store Setup's "Several
      // branches" lock and the topbar location switcher.
      multiBranchAllowed,
      branchesAllowed,
      hasDeliveryAreas: activeDeliveryAreaCount > 0,
      // What the storefront asks the shopper for (derived from zone coverage):
      // 'PINCODE' | 'LOCATION' | 'BOTH' | 'NONE'. NONE = deliver-anywhere flat
      // rate (no prompt). Drives LocationPrompt's inputs.
      deliveryLocationInput,
      // Store-level flat delivery (deliver-anywhere baseline + outside-zone
      // fallback). Shown on the storefront so a no-zone store still surfaces a
      // delivery charge + ETA. branchesAllowed handles plan gating separately.
      flatDeliveryFeeMinor: business.flatDeliveryFeeMinor ?? 0,
      flatFreeDeliveryThresholdMinor: business.flatFreeDeliveryThresholdMinor ?? 0,
      deliveryEtaMinutes: business.deliveryEtaMinutes ?? null,
    },
    subscription: sub
      ? {
          status,
          theme,
          // Four-dimensional storefront identity (April 2026):
          //   theme + themeStyle + themeColors → tokens (colours, type)
          //   designPreset + sectionVariants    → page LAYOUT (which section
          //                                        variants render & how)
          // Pre-layout-system tenants see designPreset=null which the
          // storefront resolves to "classic" — no visual change for them.
          themeStyle: sub.themeStyle || 'light',
          themeColors: sub.themeColors || null,
          designPreset: sub.designPreset || null,
          sectionVariants: sub.sectionVariants || null,
          billingCycle: sub.billingCycle,
          // customDomain stays on the business payload so admin/public shells
          // have one stable place to read it.
          tier: sub.tier ? { name: sub.tier.name, slug: sub.tier.slug } : null,
          features,
        }
      : { features },
    theme,
    bookingTheme,
    ecomTheme,
    themeVocab,
    themeKpiLabels,
    bookingOpen,
    features,
    // Heal stale theme copy: existing tenants carry a snapshot of the theme's
    // default copy taken at theme-selection time, which doesn't pick up later
    // theme improvements. healThemeCopy swaps only fields whose saved value is
    // exactly a known old default — owner-typed content is never matched.
    content: healThemeCopy(business.content) || {},
    seoSettings: business.seoSettings || null,
    services,
    staff,
    locations,
    reviews,
    specialties,
    soloMode,
  });
}

// GET /api/tenant/me
// Returns the same payload as /resolve, but the tenant is identified by the
// caller's JWT (req.user.businessId) rather than URL slug or hostname.
//
// Used by the unified-admin domain (app.aapkatech.com / app.sitepresso.com)
// where the URL has no slug — the logged-in user IS the tenant context.
//
// Auth-required (BUSINESS_ADMIN, STAFF, or SUPER_ADMIN). Without a session,
// returns 401 — the unified-admin shell redirects unauthenticated users to
// /login on the same domain.
async function me(req, res) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    // SUPER_ADMIN without a businessId still has a user record — they don't
    // own a business but should be able to see admin if they impersonate one.
    // For now: return 404 so the frontend redirects to a business picker
    // (or signup if super-admin hasn't set one up).
    return res.status(404).json({ message: 'No business associated with this user' });
  }
  // Re-use the same shape as resolve() by setting req.query.slug + recursing.
  // Cleaner: copy the resolution logic, but a single shared payload shape is
  // worth a tiny detour through Prisma.
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { slug: true },
  });
  if (!business) return res.status(404).json({ message: 'Business not found' });
  // Reuse the existing resolve() by setting query.slug — keeps payload in
  // exactly one place. resolve() handles inactive / suspended / draft etc.
  req.query.slug = business.slug;
  req._selfContext = true; // dashboard context: keep full payload + needsRenewal flag
  return resolve(req, res);
}

module.exports = { resolve, me, resolveFeatures, resolveFeatureSettings, featureEnabled };
