const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('../lib/prisma');
const { ROLES } = require('../lib/roles');
const { writeAudit } = require('../lib/audit');

// Branding-relevant keys within BusinessContent — a change to any of these is
// audited as a 'branding.change' sensitive action.
const BRANDING_KEYS = new Set([
  'logoUrl', 'logoSourceUrl', 'logoAspect', 'faviconUrl', 'tagline', 'heroBannerUrl',
]);
const { generateUniqueBusinessShortId } = require('../lib/businessShortId');
const { effectivePermissions, hasPermission } = require('../lib/rbac');
const { sendTrackedEmail, sendStaffInviteEmail } = require('../utils/email');
const { EMAIL_EVENTS } = require('../lib/emailEvents');
const { validateSignupEmail, validatePhone } = require('../lib/inputValidation');
const { slugify: rawSlugify } = require('../lib/slugify');
const { assertNumericLimit, billableStaffSeatCount, numericEntitlement } = require('../lib/entitlements');
const { ensureDefaultHrRole } = require('../middleware/auth.middleware');
const {
  hostForSlug,
  isStaging,
  provisionSubdomain,
  deprovisionSubdomain,
} = require('../lib/subdomainProvision');
const { isCloudflareCustomHostnameConfigured } = require('./subscription.controller');

// HR operator console login URL for a tenant. Replaces the deleted vertical
// staffPortalUrlForBusiness helper.
function staffPortalUrlForBusiness(business, platformBaseUrl) {
  const base = String(platformBaseUrl || '').replace(/\/$/, '');
  const slug = business?.slug;
  return slug ? `${base}/${slug}/staff` : `${base}/business`;
}
const { getDefaultCurrency } = require('../lib/currency');
const razorpayRoute = require('../lib/razorpayRoute');
const stripeConnect = require('../lib/stripeConnect');
const {
  buildTenantPaymentReadiness,
  onlineModeBlock,
} = require('../lib/billing/tenantPaymentReadiness');

// Business slugs are kept tight (60 chars) so they compose into clean
// subdomains (<slug>.drifthr.com) and admin URLs.
function slugify(name) {
  return rawSlugify(name, 60);
}

function userCan(user, key) {
  if (!user) return false;
  if (user.role === ROLES.SUPER_ADMIN || user.role === ROLES.BUSINESS_ADMIN) return true;
  return hasPermission(effectivePermissions(user), key);
}

function tenantProviderConfigured(provider) {
  return provider === 'RAZORPAY' ? razorpayRoute.isConfigured() : stripeConnect.isConfigured();
}

// Ensure slug is unique AND not a reserved infra slug — if taken or reserved,
// append a short random suffix. Reserved-word enforcement here covers the
// name-derived path (where no explicit slug is validated upstream), so a
// business merely NAMED "Demo"/"Admin"/"App" cannot claim an infra host.
async function uniqueSlug(base, ignoreId = null) {
  let candidate = base || 'business';
  let attempts = 0;
  while (attempts < 10) {
    const reserved = RESERVED_SLUGS.has(candidate);
    const existing = reserved ? true : await prisma.business.findUnique({ where: { slug: candidate } });
    if (!reserved && (!existing || existing.id === ignoreId)) return candidate;
    const suffix = crypto.randomBytes(2).toString('hex');
    candidate = `${base}-${suffix}`;
    attempts++;
  }
  // Fallback: append a longer random suffix
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

// Slugs that can never be claimed by a business (platform infrastructure)
const RESERVED_SLUGS = new Set([
  'api', 'www', 'admin', 'app', 'mail', 'platform', 'status', 'docs',
  'help', 'support', 'staging', 'dev', 'test', 'blog', 'shop',
  // Staging-host prefixes that must never be claimable as a tenant slug
  // (would collide with infra hosts e.g. demo-staging / saas-origin).
  'demo', 'saas-origin',
]);

function parsePageSize(value, fallback = 25, max = 100) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

// Build up to 3 free, available slug suggestions near a desired slug. Used to
// turn a "reserved"/"taken" dead end into actionable options the operator can
// click. Tries numeric suffixes first (acme-1), then a couple of common words
// (acme-hr, acme-team), and finally a short random suffix — skipping any that
// are themselves reserved or already taken. Best-effort: never throws.
async function suggestAvailableSlugs(base, { limit = 3 } = {}) {
  const root = String(base || '').replace(/-+$/, '') || 'team';
  const candidates = [
    `${root}-1`, `${root}-2`, `${root}-hr`, `${root}-team`, `${root}-co`,
    `${root}-${crypto.randomBytes(2).toString('hex')}`,
  ];
  const out = [];
  for (const candidate of candidates) {
    const norm = slugify(candidate);
    if (!norm || norm === root || out.includes(norm)) continue;
    if (RESERVED_SLUGS.has(norm)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const taken = await prisma.business.findUnique({ where: { slug: norm }, select: { id: true } });
      if (!taken) out.push(norm);
    } catch {
      // DB hiccup — skip this candidate rather than fail the whole check.
    }
    if (out.length >= limit) break;
  }
  return out;
}

// Human-readable copy for each machine reason — kept here so any non-UI caller
// (emails, logs) gets a sentence, while clients branch on the stable `reason`.
const SLUG_REASON_MESSAGES = {
  invalid: 'Use letters, numbers and hyphens only.',
  reserved: 'This name is reserved.',
  taken: 'Already in use.',
};

// GET /api/business/check-slug?slug=acme-barber — public availability check.
// Returns a STABLE machine `reason` ('invalid' | 'reserved' | 'taken' | null)
// so clients can branch reliably, plus a human `message` for display/logging
// and `suggestions` (free alternatives) when the slug is reserved or taken.
async function checkSlug(req, res) {
  const raw = String(req.query.slug || '').trim();
  if (!raw) return res.status(400).json({ message: 'slug is required' });

  const normalized = slugify(raw);
  if (!normalized) {
    return res.json({
      slug: '', available: false, reason: 'invalid', message: SLUG_REASON_MESSAGES.invalid, suggestions: [],
    });
  }
  if (RESERVED_SLUGS.has(normalized)) {
    return res.json({
      slug: normalized,
      available: false,
      reason: 'reserved',
      message: SLUG_REASON_MESSAGES.reserved,
      suggestions: await suggestAvailableSlugs(normalized),
      url: `https://${hostForSlug(normalized)}`,
    });
  }

  const existing = await prisma.business.findUnique({ where: { slug: normalized } });
  res.json({
    slug: normalized,
    available: !existing,
    reason: existing ? 'taken' : null,
    message: existing ? SLUG_REASON_MESSAGES.taken : null,
    suggestions: existing ? await suggestAvailableSlugs(normalized) : [],
    // The real provisioned host ({slug}-staging.drifthr.com), not {slug}.PLATFORM_DOMAIN —
    // keeps the availability preview consistent with what gets provisioned.
    url: `https://${hostForSlug(normalized)}`,
  });
}

// POST /api/business/setup
// Create a business if the user doesn't have one, or update their existing one.
// Promotes the user to BUSINESS_ADMIN on creation.
// If slug is explicitly provided, it must be available — no auto-suffix.
async function setup(req, res) {
  // Schema (setupBusinessSchema in lib/schemas/business.schema.js)
  // already enforced: name length, description length, country
  // 2-char uppercased, bookingType enum, reviewRequestLink http(s)
  // prefix + 500-char cap. Email + phone format checks stay here
  // because they share rules with signup (disposable-email block,
  // digit-count phone refinement).
  const { name, slug, description, address, state, country, timezone, phone, email, contactName, taxId, addressLine2, city, postalCode, category, profession, theme: pickedTheme, bookingType, reviewRequestEnabled, reviewRequestLink, autoConfirmBookings, defaultLanguage, defaultCurrency, vertical } = req.body;
  const normalisedReviewLink = reviewRequestLink !== undefined ? (reviewRequestLink || null) : undefined;
  const normalisedBookingType = bookingType;

  // Profession-aware vertical resolution. Onboarding now sends a
  // profession key from the SECTORS taxonomy (e.g. "bakery"). The
  // taxonomy maps each profession to a recommended vertical. Rules:
  //   - If client supplied an explicit `vertical`, honour it (override).
  //   - Else if profession is known in the taxonomy, use its
  //     recommended vertical.
  //   - Else fall back to whatever the schema default would have been
  //     (no change to the data we write).
  // We also persist the profession key in `category` so the existing
  // single-column read paths keep working without a schema migration.
  const { getRecommendedVertical, isValidProfession } = require('../lib/professions');
  let resolvedVertical = vertical;
  if (!resolvedVertical && isValidProfession(profession)) {
    resolvedVertical = getRecommendedVertical(profession);
  }
  const resolvedCategory = (profession && isValidProfession(profession)) ? profession : category;

  // Derive default currency from country at signup if the client didn't
  // pass one. Country → currency mapping reuses the platform countries
  // table (lib/countries.js style); for a small list inline so the
  // backend doesn't depend on the platform module.
  const COUNTRY_CURRENCY = {
    IN: 'INR', US: 'USD', GB: 'GBP', AU: 'AUD', NZ: 'NZD', CA: 'CAD',
    SG: 'SGD', HK: 'HKD', JP: 'JPY', KR: 'KRW', BR: 'BRL', MX: 'MXN',
    ZA: 'ZAR', AE: 'AED', SA: 'SAR', PK: 'PKR', BD: 'BDT', NG: 'NGN',
    EG: 'EGP', TR: 'TRY',
    // EU members default to EUR
    DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR',
    PT: 'EUR', AT: 'EUR', IE: 'EUR', FI: 'EUR', GR: 'EUR', LU: 'EUR',
  };
  const resolvedDefaultCurrency = defaultCurrency
    || (country ? COUNTRY_CURRENCY[String(country).toUpperCase().slice(0, 2)] : null)
    || null;

  if (email) {
    const emailError = validateSignupEmail(email);
    if (emailError) return res.status(400).json({ message: emailError });
  }
  const phoneError = validatePhone(phone);
  if (phoneError) return res.status(400).json({ message: phoneError });

  const userId = req.user.id;
  const existingBusinessId = req.user.businessId;

  const baseSlug = slug ? slugify(slug) : slugify(name);

  // If user explicitly chose a slug, validate it's available (don't auto-suffix)
  if (slug) {
    if (RESERVED_SLUGS.has(baseSlug)) {
      return res.status(409).json({ message: `"${baseSlug}" is a reserved name. Please choose another.` });
    }
    const conflict = await prisma.business.findUnique({ where: { slug: baseSlug } });
    if (conflict && conflict.id !== existingBusinessId) {
      return res.status(409).json({ message: `"${baseSlug}" is already taken. Please choose another.` });
    }
  }

  if (existingBusinessId) {
    // Update existing business
    const current = await prisma.business.findUnique({ where: { id: existingBusinessId } });
    if (!current) {
      return res.status(404).json({ message: 'Business not found' });
    }

    const finalSlug = slug
      ? baseSlug // user explicitly chose it (already validated above)
      : baseSlug === current.slug
        ? current.slug
        : await uniqueSlug(baseSlug, existingBusinessId);

    // Slug cooldown — once a site is PUBLISHED its URL lives in bookmarks,
    // share links and SEO, so via the admin it can change at most once every
    // 30 days. During onboarding (the setup wizard sends ?onboarding=1) the URL
    // is still being chosen and nothing public depends on it, so changes are
    // free and the 30-day clock doesn't start until the site is live.
    const isOnboarding = req.query.onboarding === '1' || req.query.onboarding === 'true';
    const slugChanging = finalSlug !== current.slug;
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    if (slugChanging && !isOnboarding && current.slugLastChangedAt) {
      const elapsed = Date.now() - new Date(current.slugLastChangedAt).getTime();
      if (elapsed < THIRTY_DAYS_MS) {
        const daysLeft = Math.ceil((THIRTY_DAYS_MS - elapsed) / (24 * 60 * 60 * 1000));
        const nextAvailableAt = new Date(new Date(current.slugLastChangedAt).getTime() + THIRTY_DAYS_MS);
        return res.status(429).json({
          message: `You can change your URL once every 30 days. Next change available in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
          nextAvailableAt: nextAvailableAt.toISOString(),
          slugLastChangedAt: current.slugLastChangedAt,
        });
      }
    }

    // Currency can be changed freely (the old 90-day cooldown was removed).
    const newCurrency = resolvedDefaultCurrency ? String(resolvedDefaultCurrency).toUpperCase() : null;

    const business = await prisma.business.update({
      where: { id: existingBusinessId },
      data: {
        name: name.trim(),
        slug: finalSlug,
        // The URL-change clock only runs for live sites. Onboarding saves keep
        // it null — so the cooldown starts fresh once the site is launched and
        // stale onboarding churn never locks a not-yet-published site.
        slugLastChangedAt: isOnboarding ? null : (slugChanging ? new Date() : current.slugLastChangedAt),
        description: description !== undefined ? (description ?? null) : current.description,
        address: address !== undefined ? (address ?? null) : current.address,
        addressLine2: addressLine2 !== undefined ? (addressLine2 ?? null) : current.addressLine2,
        city: city !== undefined ? (city ?? null) : current.city,
        postalCode: postalCode !== undefined ? (postalCode ?? null) : current.postalCode,
        state: state !== undefined ? (state ?? null) : current.state,
        country: country !== undefined ? (country ? String(country).toUpperCase().slice(0, 2) : null) : current.country,
        timezone: timezone !== undefined ? (timezone ? String(timezone) : null) : current.timezone,
        phone: phone !== undefined ? (phone ?? null) : current.phone,
        email: email !== undefined ? (email ?? null) : current.email,
        // Keep the billing profile in sync with onboarding edits — but NOT
        // billingCountry, which is locked after signup (cross-gateway changes
        // are guarded in updateBillingProfile).
        ...(contactName !== undefined ? { billingContactName: contactName ?? null } : {}),
        ...(taxId !== undefined ? { billingTaxId: taxId ?? null } : {}),
        ...(state !== undefined ? { billingState: state ?? null } : {}),
        ...(address !== undefined ? { billingAddressLine1: address ?? null } : {}),
        ...(addressLine2 !== undefined ? { billingAddressLine2: addressLine2 ?? null } : {}),
        ...(city !== undefined ? { billingCity: city ?? null } : {}),
        ...(postalCode !== undefined ? { billingPostalCode: postalCode ?? null } : {}),
        category: resolvedCategory !== undefined ? (resolvedCategory ?? null) : current.category,
        ...(normalisedBookingType ? { bookingType: normalisedBookingType } : {}),
        ...(reviewRequestEnabled !== undefined ? { reviewRequestEnabled: !!reviewRequestEnabled } : {}),
        ...(autoConfirmBookings !== undefined ? { autoConfirmBookings: !!autoConfirmBookings } : {}),
        ...(normalisedReviewLink !== undefined ? { reviewRequestLink: normalisedReviewLink } : {}),
        ...(defaultLanguage !== undefined ? { defaultLanguage: defaultLanguage || null } : {}),
        ...(defaultCurrency !== undefined ? {
          defaultCurrency: newCurrency || null,
        } : {}),
        ...(resolvedVertical !== undefined ? { vertical: resolvedVertical } : {}),
      },
    });
    // Provision the DriftHR subdomain on first set / on change (best-effort —
    // never throws; the slug write above already succeeded).
    if (slugChanging || !current.slugLastChangedAt) {
      await provisionSubdomain({ businessId: existingBusinessId, slug: finalSlug, staging: isStaging() });
    }
    return res.json({ business });
  }

  // Create new business + promote user
  const finalSlug = slug ? baseSlug : await uniqueSlug(baseSlug);
  const business = await prisma.business.create({
    data: {
      name: name.trim(),
      slug: finalSlug,
      shortId: await generateUniqueBusinessShortId(),
      ...(resolvedVertical ? { vertical: resolvedVertical } : {}),
      description: description ?? null,
      address: address ?? null,
      addressLine2: addressLine2 ?? null,
      city: city ?? null,
      postalCode: postalCode ?? null,
      state: state ?? null,
      country: country ? String(country).toUpperCase().slice(0, 2) : null,
      timezone: timezone ? String(timezone) : null,
      phone: phone ?? null,
      email: email ?? null,
      // Mirror the onboarding contact/address into the billing profile so the
      // Billing & Plan page shows the same details out of the box. billingCountry
      // is seeded ONCE here at signup — it is the locked gateway country
      // thereafter (changes only go through the guarded updateBillingProfile).
      billingContactName: contactName ?? null,
      billingTaxId: taxId ?? null,
      billingBusinessName: name.trim(),
      billingEmail: email ?? null,
      billingCountry: country ? String(country).toUpperCase().slice(0, 2) : null,
      billingState: state ?? null,
      billingAddressLine1: address ?? null,
      billingAddressLine2: addressLine2 ?? null,
      billingCity: city ?? null,
      billingPostalCode: postalCode ?? null,
      category: resolvedCategory ?? null,
      bookingType: normalisedBookingType || 'POSTPAID',
      isActive: false, // Draft — goes live after admin completes checklist + clicks Launch
      ...(defaultLanguage ? { defaultLanguage } : {}),
      ...(resolvedDefaultCurrency ? { defaultCurrency: resolvedDefaultCurrency } : {}),
    },
  });

  // ECOMMERCE freshly-created → seed 8 starter categories so the admin
  // lands with somewhere to put their first product. Idempotent +
  // best-effort; failure here doesn't fail the whole signup.
  const createdVertical = resolvedVertical || 'APPOINTMENT';

  if (createdVertical === 'ECOMMERCE') {
    try {
      const { seedDefaultEcommerceCategories } = require('../lib/demoShopSeeder');
      await seedDefaultEcommerceCategories(business.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[setupBusiness] default categories seed failed:', err?.message || err);
    }
    // Country-aware brand catalog — pre-populate Unilever / ITC / etc.
    // for IN, Fonterra / Goodman Fielder for NZ, Bega / Arnotts for AU.
    // Seller can edit / hide / extend from the Brands panel afterwards;
    // unsupported countries silently skip (no rows added).
    if (business.country) {
      try {
        const { seedBrandsForBusiness, SUPPORTED_COUNTRIES } = require('../lib/brandCatalog');
        if (SUPPORTED_COUNTRIES.includes(String(business.country).toUpperCase())) {
          await seedBrandsForBusiness(prisma, {
            businessId: business.id,
            countryCode: business.country,
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[setupBusiness] brand catalog seed failed:', err?.message || err);
      }
    }
  }

  // Seed the HR system roles (Owner / HR-Admin / Finance / Manager) for the
  // new tenant. Idempotent; also re-runs on first operator login.
  try {
    await ensureDefaultHrRole({ businessId: business.id });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[setupBusiness] HR roles seed failed:', err?.message || err);
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      businessId: business.id,
      role: ROLES.BUSINESS_ADMIN,
      // Admin is the first team member + can take bookings from day one.
      // They can toggle isServiceProvider off later from Team → Members.
      isServiceProvider: true,
    },
  });

  // Resolve the theme up-front so the CMS seeder can pull theme-specific
  // service / team defaults (e.g. math_tuition gives Primary / GCSE /
  // A-Level cards instead of the generic "Initial consultation / Follow-
  // up / Quick chat" stubs). Usually the explicit picker wins, but draft
  // STATIC sites with strong education signals (like "math10") are kept
  // out of accidental placeholder picks such as barber.
  const { getThemeForCategory } = require('../lib/categoryTheme');
  const { resolveStaticThemeFromBusinessSignals } = require('../lib/staticThemeInference');
  const categoryTheme = getThemeForCategory(resolvedCategory);
  const initialTheme = resolveStaticThemeFromBusinessSignals({
    theme: pickedTheme || categoryTheme,
    fallbackTheme: categoryTheme,
    business: {
      name,
      slug: finalSlug,
      description,
      category: resolvedCategory,
      profession,
      vertical: createdVertical,
    },
  });

  // Seed 3 starter services priced for the business's country, a standard
  // 9-5 Mon-Fri schedule, and starter CMS content (homepage Services +
  // Team cards) so both the booking flow AND the storefront homepage
  // work from the moment the business is created. All three calls
  // swallow errors so a pricing-lookup hiccup never fails signup.
  const { seedDefaultServices, seedDefaultCmsContent, seedDefaultBusinessHours } = require('../lib/defaultServices');
  await Promise.all([
    seedDefaultServices(business.id, business.country),
    seedDefaultCmsContent(business.id, business.country, initialTheme),
    seedDefaultBusinessHours(business.id),
  ]);

  // Auto-provision a Free-tier subscription. All businesses land on Free at
  // signup; they can upgrade from the Subscription tab.
  //
  // Theme is derived from the picked profession via the central
  // CATEGORY_TO_THEME mapping (see backend/src/core/lib/categoryTheme.js).
  // Pre-2026-04-30 this was hardcoded to 'default', which fell through
  // resolveThemeKey() to 'general_practice' — every photographer, lawyer,
  // and barbershop got the medical theme.
  // A tenant MUST always leave signup with a Subscription — without one the
  // billing portal and every entitlement check dead-ends (the "tenant existed
  // with no subscription → broken portal" bug). So resolve the vertical free
  // tier, fall back to ANY active tier, and FAIL the request if neither exists
  // (a catalog-less DB is an operator error, not something to swallow into a
  // half-provisioned tenant).
  try {
    const { getFreeTierForVertical } = require('../lib/subscriptionBilling');
    // Prefer the vertical-matched free tier (free / static-free / ecom-free).
    let landingTier = await getFreeTierForVertical(business.vertical);
    // Defensive fallback: if no free tier is seeded for any reason, land on the
    // cheapest active tier so the tenant still has a working subscription + portal
    // (better a paid-tier-shaped row they can downgrade than no subscription).
    if (!landingTier) {
      landingTier = await prisma.pricingTier.findFirst({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
      });
      if (landingTier) {
        console.warn(`Free tier missing for vertical "${business.vertical}" — landed business ${business.id} on fallback tier "${landingTier.slug}". Run prisma/seeds/pricing.seed.js.`);
      }
    }
    if (!landingTier) {
      // No catalog at all. Surface a clean 500 instead of creating an orphan
      // tenant with no subscription that breaks the portal silently.
      throw new Error('Pricing catalog is empty — no tier to subscribe the new tenant to. Run prisma/seeds/pricing.seed.js.');
    }
    const forever = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
    await prisma.subscription.create({
      data: {
        businessId: business.id,
        tierId: landingTier.id,
        status: 'ACTIVE',
        billingCycle: 'MONTHLY',
        theme: initialTheme,
        currentPeriodEnd: forever,
        seatsUsed: 1,
      },
    });
  } catch (e) {
    console.error('Auto-subscription provisioning failed:', e.message);
    // A tenant without a subscription is broken — don't return 201 success on a
    // half-provisioned business. The business row exists (idempotent re-setup
    // will reuse it), but signal the failure so the client retries / shows an error.
    return res.status(500).json({
      message: 'We created your workspace but could not finish setting up billing. Please try again in a moment.',
      businessId: business.id,
    });
  }

  // Provision the DriftHR subdomain for the freshly-created tenant (best-effort).
  // Runs after the auto-subscription so the host can bind onto it.
  await provisionSubdomain({ businessId: business.id, slug: finalSlug, staging: isStaging() });

  res.status(201).json({ business });
}

// PATCH /api/business/slug  { slug }
// Self-service URL change for a LIVE tenant (Feature 3, Mode A). Unlike the
// onboarding setup() path, this is the dedicated, audited slug-change endpoint:
//   slugify → reserved (409) → no-op if same (200) → uniqueness, NO auto-suffix
//   (409 taken) → 30-day cooldown via slugLastChangedAt (429) → provision the
//   NEW subdomain FIRST (best-effort) → update slug + stamp → deprovision the
//   OLD subdomain (tag-gated, best-effort) → audit → { slug, url }.
// The existing PATCH /settings silently drops slug — this is the only way to
// change it post-onboarding.
async function changeSlug(req, res) {
  const businessId = req.user.businessId;
  if (!businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  const newSlug = slugify(req.body.slug);
  if (!newSlug) {
    return res.status(400).json({ message: 'slug is required' });
  }
  if (RESERVED_SLUGS.has(newSlug)) {
    return res.status(409).json({ reason: 'reserved', message: `"${newSlug}" is a reserved name. Please choose another.` });
  }

  // Load the business WITH its subscription so we can deprovision the ACTUAL
  // stored host on cutover (not a host re-derived from the old slug + the
  // ambient staging flag, which orphans the real record if the env flag flips).
  const current = await prisma.business.findUnique({
    where: { id: businessId },
    include: { subscription: { select: { customDomain: true } } },
  });
  if (!current) {
    return res.status(404).json({ message: 'Business not found' });
  }

  // No-op: same slug → succeed without touching DNS, the cooldown, or audit.
  if (newSlug === current.slug) {
    return res.json({ slug: newSlug, url: `https://${hostForSlug(newSlug)}`, unchanged: true });
  }

  // Uniqueness — NO auto-suffix (the admin chose this exact name).
  const conflict = await prisma.business.findUnique({ where: { slug: newSlug } });
  if (conflict && conflict.id !== businessId) {
    return res.status(409).json({ reason: 'taken', message: `"${newSlug}" is already taken. Please choose another.` });
  }

  // 30-day cooldown — a published URL lives in bookmarks/share links/SEO, so it
  // can change at most once every 30 days (mirrors the setup() cooldown block).
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  if (current.slugLastChangedAt) {
    const elapsed = Date.now() - new Date(current.slugLastChangedAt).getTime();
    if (elapsed < THIRTY_DAYS_MS) {
      const daysLeft = Math.ceil((THIRTY_DAYS_MS - elapsed) / (24 * 60 * 60 * 1000));
      const nextAvailableAt = new Date(new Date(current.slugLastChangedAt).getTime() + THIRTY_DAYS_MS);
      return res.status(429).json({
        reason: 'cooldown',
        message: `You can change your URL once every 30 days. Next change available in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
        nextAvailableAt: nextAvailableAt.toISOString(),
        slugLastChangedAt: current.slugLastChangedAt,
      });
    }
  }

  // Deprovision the ACTUAL provisioned host stored on the subscription (not a
  // host re-derived from the old slug). Only deprovision *.drifthr.com hosts —
  // never tear down a real custom domain a tenant connected by hand.
  const platformZone = String(process.env.PLATFORM_DOMAIN || 'drifthr.com').toLowerCase();
  const storedHost = String(current.subscription?.customDomain || '').trim().toLowerCase();
  const oldHost = (storedHost && (storedHost === platformZone || storedHost.endsWith(`.${platformZone}`)))
    ? storedHost
    : null;
  const newHost = hostForSlug(newSlug);

  // Provision the NEW host FIRST so the new URL is live before we cut over
  // (QA §5 case 2 — new live before old removed). Best-effort: never throws.
  const provision = await provisionSubdomain({ businessId, slug: newSlug, staging: isStaging() });

  // WRITE tag-gate / unique-constraint refusal — the new host is owned by infra
  // or another tenant. Do NOT write the slug; surface 409 {host-unavailable|taken}.
  if (provision?.refused) {
    const reason = provision.reason === 'taken' ? 'taken' : 'host-unavailable';
    return res.status(409).json({
      reason,
      message: reason === 'taken'
        ? `"${newSlug}" maps to a domain that is already taken. Please choose another.`
        : `"${newSlug}" maps to an unavailable host. Please choose another.`,
    });
  }

  await prisma.business.update({
    where: { id: businessId },
    data: { slug: newSlug, slugLastChangedAt: new Date() },
  });

  // Tear down the OLD host (tag-gated, best-effort) only after the cutover.
  if (oldHost && oldHost !== newHost) {
    await deprovisionSubdomain({ businessId, host: oldHost });
  }

  await writeAudit({
    businessId,
    actorId: req.user.id,
    action: 'business.slug.change',
    entityType: 'Business',
    entityId: businessId,
    meta: { from: current.slug || null, to: newSlug, host: newHost },
  });

  return res.json({ slug: newSlug, url: `https://${newHost}` });
}

// GET /api/business/domain-config
// Readiness + shape for the admin Domain settings UI. customDomainEnabled
// reflects whether Cloudflare-for-SaaS custom hostnames are configured (Mode B
// gate); subdomain self-service (Mode A) is always available.
async function getDomainConfig(req, res) {
  const staging = isStaging();
  return res.json({
    customDomainEnabled: isCloudflareCustomHostnameConfigured(),
    platformDomain: process.env.PLATFORM_DOMAIN || 'drifthr.com',
    subdomainSuffix: staging ? '-staging.drifthr.com' : '.drifthr.com',
    targetCname: process.env.CUSTOM_DOMAIN_TARGET_CNAME || null,
  });
}

// GET /api/business/me
async function getMyBusiness(req, res) {
  if (!req.user.businessId) {
    return res.status(404).json({ message: 'No business associated with this account' });
  }
  const business = await prisma.business.findUnique({
    where: { id: req.user.businessId },
    include: {
      _count: { select: { services: true, appointments: true } },
      subscription: { select: { theme: true } },
    },
  });
  if (!business) {
    return res.status(404).json({ message: 'Business not found' });
  }
  const staffCount = await prisma.user.count({
    where: { businessId: business.id, role: ROLES.STAFF, isActive: true },
  });

  // Website-vertical dashboard stats. STATIC tenants have no bookings, so the
  // overview shows web-relevant numbers instead: leads (enquiries), published
  // content, and domains. Computed only for STATIC to keep /me lean for
  // booking/ecommerce tenants.
  let webStats = null;
  if ((business.vertical || 'APPOINTMENT') === 'STATIC') {
    const since30 = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
    since30.setHours(0, 0, 0, 0);
    const [
      enquiriesNew, enquiriesTotal,
      pagesPublished, blogPublished, domainsActive,
      recentEnquiries, trendRows,
    ] = await Promise.all([
      prisma.enquiry.count({ where: { businessId: business.id, status: 'NEW' } }),
      prisma.enquiry.count({ where: { businessId: business.id } }),
      prisma.businessPage.count({ where: { businessId: business.id, isPublished: true } }),
      prisma.blogPost.count({ where: { businessId: business.id, isPublished: true } }),
      // Domain RESALE removed (custom-domain BINDING only). This STATIC/web
      // vertical dashboard tile is legacy dead code in the HR fork; no Domain
      // model to count, so report zero.
      Promise.resolve(0),
      prisma.enquiry.findMany({
        where: { businessId: business.id },
        orderBy: { createdAt: 'desc' },
        take: 6,
        select: { id: true, name: true, subject: true, message: true, status: true, createdAt: true },
      }),
      prisma.enquiry.findMany({
        where: { businessId: business.id, createdAt: { gte: since30 } },
        select: { createdAt: true },
      }),
    ]);
    // Bucket the last 30 days into a daily count series for a compact sparkline.
    const buckets = [];
    const dayMs = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 30; i += 1) {
      const d = new Date(since30.getTime() + i * dayMs);
      buckets.push({ date: d.toISOString().slice(0, 10), count: 0 });
    }
    const indexByDate = new Map(buckets.map((b, i) => [b.date, i]));
    for (const row of trendRows) {
      const key = new Date(row.createdAt).toISOString().slice(0, 10);
      const idx = indexByDate.get(key);
      if (idx !== undefined) buckets[idx].count += 1;
    }
    webStats = {
      enquiriesNew, enquiriesTotal,
      pagesPublished, blogPublished, domainsActive,
      recentEnquiries, enquiryTrend: buckets,
    };
  }

  // Theme-driven labels for the centralized admin shell. Falls back to
  // `null` when the tenant's theme has no per-theme overrides — admin
  // then renders the existing i18n labels untouched.
  const { getAdminVocab, getKpiLabels } = require('../lib/themeRegistry');
  const themeKey = business.subscription?.theme || null;
  const themeVocab = getAdminVocab(themeKey);
  const themeKpiLabels = getKpiLabels(themeKey);

  res.json({
    business,
    stats: {
      staffCount,
      serviceCount: business._count.services,
      appointmentCount: business._count.appointments,
      webStats,
    },
    theme: themeKey,
    themeVocab,
    themeKpiLabels,
  });
}

// GET /api/business/context
// Lightweight business context for any authenticated business user
// (owner, staff, future support roles). Used by login redirects where we
// only need the business slug and should not require BUSINESS_ADMIN.
async function getMyBusinessContext(req, res) {
  if (!req.user.businessId) {
    return res.status(404).json({ message: 'No business associated with this account' });
  }

  const business = await prisma.business.findUnique({
    where: { id: req.user.businessId },
    select: {
      id: true, name: true, slug: true, vertical: true,
      subscription: {
        select: {
          status: true, paddleSubscriptionId: true, stripeSubscriptionId: true,
          razorpaySubscriptionId: true, currentPeriodEnd: true,
          trialEndsAt: true, accessGraceUntil: true, activatedAt: true,
          tier: { select: { slug: true } },
        },
      },
    },
  });

  if (!business) {
    return res.status(404).json({ message: 'Business not found' });
  }

  // Billing renew-gate state, so the dashboard can lock to Billing when due.
  const { billingAccessState } = require('../lib/billingAccess');
  const access = billingAccessState(business);

  res.json({
    business: { id: business.id, name: business.name, slug: business.slug, vertical: business.vertical },
    billingState: access.state, // 'onboarding' | 'active' | 'grace' | 'expired'
    graceUntil: access.graceUntil || null,
    needsRenewal: access.state === 'expired',
  });
}

// POST /api/business/staff — invite a staff member by email
async function inviteStaff(req, res) {
  const { email, name, businessRoleId } = req.body;

  if (!email || !name) {
    return res.status(400).json({ message: 'Email and name are required' });
  }

  const emailError = validateSignupEmail(email);
  if (emailError) return res.status(400).json({ message: emailError });

  const businessId = req.user.businessId;
  if (!businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) {
    return res.status(404).json({ message: 'Business not found' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  const activeTeamCount = await billableStaffSeatCount(businessId);
  const addsSeat = !existingUser || existingUser.businessId !== businessId || existingUser.isActive === false;
  if (addsSeat) {
    try {
      await assertNumericLimit({
        businessId,
        key: 'staff_count',
        currentCount: activeTeamCount,
        increment: 1,
        label: 'team member seats',
      });
    } catch (err) {
      return res.status(err.status || 500).json({
        message: err.message || 'Plan limit reached.',
        code: err.code || 'plan_limit_error',
        entitlement: err.entitlement || null,
        currentCount: err.currentCount,
      });
    }
  }

  // Generate a temporary password the staff member can use to log in
  const tempPassword = crypto.randomBytes(9).toString('hex'); // 18-char hex (~72-bit) invite credential
  const hashedPassword = await bcrypt.hash(tempPassword, 12);

  let staffUser;
  if (existingUser) {
    if (existingUser.businessId && existingUser.businessId !== businessId) {
      return res.status(409).json({ message: 'That email already belongs to another business' });
    }
    staffUser = await prisma.user.update({
      where: { id: existingUser.id },
      data: {
        businessId,
        role: ROLES.STAFF,
        isActive: true,
        password: hashedPassword,
      },
      select: { id: true, email: true, name: true, role: true },
    });
  } else {
    staffUser = await prisma.user.create({
      data: {
        email: normalizedEmail,
        name: name.trim(),
        password: hashedPassword,
        role: ROLES.STAFF,
        businessId,
        // Admin-invited: credential delivered to this email proves ownership;
        // there is no OTP step for staff, so they are verified on creation.
        emailVerified: true,
      },
      select: { id: true, email: true, name: true, role: true },
    });
  }

  // Ensure the tenant's HR system roles exist, then assign the requested
  // role if one was supplied. Role assignment is explicit — no vertical
  // auto-provisioning. Without a businessRoleId the user falls back to the
  // legacy STAFF enum permission set (see rbac.js LEGACY_ROLE_PERMS).
  try {
    await ensureDefaultHrRole({ businessId });
    if (businessRoleId) {
      const role = await prisma.businessRole.findFirst({
        where: { id: businessRoleId, businessId },
        select: { id: true, name: true, permissions: true, isSystem: true },
      });
      if (!role) {
        return res.status(400).json({ message: 'Role not found in this business' });
      }
      await prisma.user.update({
        where: { id: staffUser.id },
        data: { businessRoleId: role.id },
      });
      staffUser = { ...staffUser, businessRoleId: role.id, businessRole: role };
    }
  } catch (roleErr) {
    if (roleErr.statusCode) return res.status(roleErr.statusCode).json({ message: roleErr.message });
    throw roleErr;
  }

  // Canonical staff entry point now lives on the platform path-based portal.
  const platformDomain = process.env.PLATFORM_DOMAIN || 'drifthr.com';
  const platformBaseUrl = (process.env.NEXT_PUBLIC_PLATFORM_URL || process.env.FRONTEND_URL || `https://${platformDomain}`).replace(/\/$/, '');
  const loginUrl = staffPortalUrlForBusiness(business, platformBaseUrl);

  try {
    await sendStaffInviteEmail(normalizedEmail, name.trim(), loginUrl, tempPassword, {
      businessName: business.name,
      businessId,
      userId: staffUser.id,
      metadata: {
        inviterName: req.user.name,
        loginUrl,
      },
    });
  } catch (emailErr) {
    console.error('Staff invite email error:', emailErr.message);
  }

  res.status(201).json({ staff: staffUser, message: 'Invitation sent' });
}

// POST /api/business/staff/card
// Lightweight staff creation for the Website editor's inline Team cards —
// no email invite, no login credentials. Creates a display-only staff
// record the business admin can fill in later from the Staff tab (where
// we can promote it to a real invited user by updating the email).
async function quickAddStaff(req, res) {
  const businessId = req.user.businessId;
  if (!businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const { name, subtitle, bio } = req.body || {};
  const activeTeamCount = await billableStaffSeatCount(businessId);
  try {
    await assertNumericLimit({
      businessId,
      key: 'staff_count',
      currentCount: activeTeamCount,
      increment: 1,
      label: 'team member seats',
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      message: err.message || 'Plan limit reached.',
      code: err.code || 'plan_limit_error',
      entitlement: err.entitlement || null,
      currentCount: err.currentCount,
    });
  }

  // Synthetic, guaranteed-unique email so the User row is valid. We use a
  // .invalid TLD (reserved by RFC 2606) so it can never collide with a
  // real address and no email will ever be delivered to it.
  const placeholderEmail = `team-${crypto.randomBytes(8).toString('hex')}@drifthr.invalid`;
  const randomPassword = crypto.randomBytes(24).toString('hex');
  const hashed = await bcrypt.hash(randomPassword, 12);

  let staff = await prisma.user.create({
    data: {
      email: placeholderEmail,
      name: (name || 'New team member').trim().slice(0, 80),
      password: hashed,
      role: ROLES.STAFF,
      businessId,
      emailVerified: true, // admin-created team member (no self-signup/OTP step)
      subtitle: subtitle ? String(subtitle).trim().slice(0, 80) : null,
      bio: bio ? String(bio).trim().slice(0, 600) : null,
    },
    select: { id: true, email: true, name: true, role: true, avatarUrl: true, subtitle: true, bio: true, isActive: true, isServiceProvider: true, createdAt: true },
  });
  // Display-only team card — no vertical role auto-assignment. The admin
  // promotes it to a permissioned operator later from the Team tab by
  // assigning an HR BusinessRole (Owner/HR-Admin/Finance/Manager).
  res.status(201).json({ staff });
}

// GET /api/business/staff
async function listStaff(req, res) {
  const businessId = req.user.businessId;
  if (!businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  // Include the business admin/owner as well — they're a team member too.
  // The UI uses the `role` field to mark the admin's row specially (owner badge,
  // no remove button) and to enforce "at least one visible" when solo.
  const staff = await prisma.user.findMany({
    where: { businessId, role: { in: [ROLES.BUSINESS_ADMIN, ROLES.STAFF] } },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      avatarUrl: true,
      signatureUrl: true,
      stampUrl: true,
      subtitle: true,
      bio: true,
      isActive: true,
      showOnWebsite: true,
      isServiceProvider: true,
      createdAt: true,
      businessRoleId: true,
      businessRole: { select: { id: true, name: true, isSystem: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ staff });
}

// PATCH /api/business/staff/:id — update name/avatar for a staff member (or self)
async function updateStaff(req, res) {
  const { id } = req.params;
  const businessId = req.user.businessId;
  if (!businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target || target.businessId !== businessId) {
    return res.status(404).json({ message: 'Team member not found' });
  }

  const data = {};
  if (typeof req.body.name === 'string' && req.body.name.trim()) {
    data.name = req.body.name.trim();
  }
  if (req.body.avatarUrl !== undefined) {
    // Accept null or string (base64 data URL or remote URL). Enforce a max.
    const v = req.body.avatarUrl;
    if (v === null || v === '') {
      data.avatarUrl = null;
    } else if (typeof v === 'string') {
      if (v.length > 2_500_000) {
        return res.status(400).json({ message: 'Avatar image too large (max ~2MB)' });
      }
      data.avatarUrl = v;
    }
  }
  if (req.body.signatureUrl !== undefined) {
    const v = req.body.signatureUrl;
    if (v === null || v === '') {
      data.signatureUrl = null;
    } else if (typeof v === 'string') {
      if (v.length > 2_500_000) {
        return res.status(400).json({ message: 'Signature image too large (max ~2MB)' });
      }
      data.signatureUrl = v;
    }
  }
  if (req.body.stampUrl !== undefined) {
    const v = req.body.stampUrl;
    if (v === null || v === '') {
      data.stampUrl = null;
    } else if (typeof v === 'string') {
      if (v.length > 2_500_000) {
        return res.status(400).json({ message: 'Stamp image too large (max ~2MB)' });
      }
      data.stampUrl = v;
    }
  }
  if (req.body.subtitle !== undefined) {
    const v = req.body.subtitle;
    data.subtitle = typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null;
  }
  if (req.body.bio !== undefined) {
    const v = req.body.bio;
    data.bio = typeof v === 'string' && v.trim() ? v.trim().slice(0, 600) : null;
  }
  // Clinical provider profile (doctor_clinic theme). One-time professional
  // identity, auto-stamped onto every Rx + shown on the storefront doctor card.
  const trimField = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  if (req.body.registrationNumber !== undefined) data.registrationNumber = trimField(req.body.registrationNumber, 80);
  if (req.body.qualification !== undefined) data.qualification = trimField(req.body.qualification, 160);
  if (req.body.speciality !== undefined) data.speciality = trimField(req.body.speciality, 120);
  // Doctor v2 — structured specialty/department assignment (empty string = unassign).
  // Validate the specialty belongs to THIS business (the FK only enforces row
  // existence, not tenant scope) so an admin can't attach another tenant's row.
  if (req.body.specialtyId !== undefined) {
    const sid = req.body.specialtyId;
    if (!sid) {
      data.specialtyId = null;
    } else {
      const sp = await prisma.specialty.findFirst({ where: { id: sid, businessId }, select: { id: true } });
      if (!sp) return res.status(400).json({ message: 'Specialty not found in this business' });
      data.specialtyId = sid;
    }
  }
  if (req.body.languages !== undefined) data.languages = trimField(req.body.languages, 160);
  if (req.body.experienceYears !== undefined) {
    const n = Number(req.body.experienceYears);
    data.experienceYears = Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 80) : null;
  }
  if (req.body.consultationFee !== undefined) {
    const n = Number(req.body.consultationFee);
    data.consultationFee = Number.isFinite(n) && n >= 0 ? Math.min(n, 1_000_000) : null;
  }
  if (req.body.showOnWebsite !== undefined) {
    data.showOnWebsite = !!req.body.showOnWebsite;
  }
  if (req.body.isServiceProvider !== undefined) {
    data.isServiceProvider = !!req.body.isServiceProvider;
  }

  // Assign / clear a custom BusinessRole. Drives JSON-permission checks
  // (requirePermission via effectivePermissions). null = legacy enum fallback.
  if (req.body.businessRoleId !== undefined) {
    const v = req.body.businessRoleId;
    if (v === null || v === '') {
      data.businessRoleId = null;
    } else if (typeof v === 'string') {
      const role = await prisma.businessRole.findFirst({
        where: { id: v, businessId },
        select: { id: true, name: true, permissions: true, isSystem: true },
      });
      if (!role) {
        return res.status(400).json({ message: 'Role not found in this business' });
      }
      data.businessRoleId = v;
    }
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: 'No updatable fields provided' });
  }

  const updated = await prisma.user.update({
    where: { id },
    data,
    select: {
      id: true, name: true, email: true, avatarUrl: true, signatureUrl: true, stampUrl: true, subtitle: true,
      bio: true, isActive: true, showOnWebsite: true, isServiceProvider: true,
      businessRoleId: true,
      businessRole: { select: { id: true, name: true, isSystem: true } },
    },
  });
  res.json({ staff: updated });
}

// DELETE /api/business/staff/:id — remove a staff member from the business
async function removeStaff(req, res) {
  const { id } = req.params;
  const businessId = req.user.businessId;

  const staff = await prisma.user.findUnique({ where: { id } });
  if (!staff || staff.businessId !== businessId || staff.role !== ROLES.STAFF) {
    return res.status(404).json({ message: 'Staff member not found' });
  }

  await prisma.user.update({
    where: { id },
    data: { businessId: null, role: ROLES.USER, isActive: false },
  });

  res.json({ message: 'Staff member removed' });
}

// GET /api/business/content — returns custom content for the business
async function getContent(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const content = await prisma.businessContent.findUnique({
    where: { businessId: req.user.businessId },
  });
  res.json({ content: content || {} });
}

// PUT /api/business/content — upsert custom content
const CONTENT_FIELDS = new Set([
  'heroHeadline', 'heroSubheading', 'heroCtaText', 'heroLine3', 'heroBannerUrl',
  'aboutTitle', 'aboutBody',
  'logoUrl', 'logoSourceUrl', 'logoAspect', 'faviconUrl', 'tagline', 'servicesIntro',
  'showStats', 'showServices', 'showAbout', 'showTeam',
  'showTestimonials', 'showContact', 'showCta',
  'showNavHome', 'showNavServices', 'showNavAbout', 'showNavContact',
  'testimonials', 'contactTitle', 'contactBody',
  'businessEmail', 'businessHoursText', 'businessAddressOverride',
  'showTopBar', 'showTopBarEmail', 'showTopBarAddress', 'showTopBarHours', 'showTopBarPhone',
  'businessPhoneOverride',
  'showHero',
  'heroTrust1', 'heroTrust2', 'heroTrust3', 'showHeroTrust',
  'socialFacebook', 'socialInstagram', 'socialTwitter', 'socialLinkedin', 'socialYoutube',
  'showSocialFacebook', 'showSocialInstagram', 'showSocialTwitter', 'showSocialLinkedin', 'showSocialYoutube',
  'navbarBusinessName', 'showLogo', 'showBusinessName', 'showTagline',
  'ctaHeadline', 'ctaBody', 'ctaBackgroundUrl',
  'aboutImageUrl', 'aboutImagePosition',
  'teamTitle', 'teamIntro',
  'statsItems',
  'policies',
  'pricingTiers', 'showPricing', 'pricingEyebrow', 'pricingTitle', 'pricingIntro',
  'servicesImageUrl', 'servicesImagePosX', 'servicesImagePosY', 'servicesImageZoom',
  'heroBannerPosX', 'heroBannerPosY', 'heroBannerZoom',
  'aboutImagePosX', 'aboutImagePosY', 'aboutImageZoom',
  'ctaBackgroundPosX', 'ctaBackgroundPosY', 'ctaBackgroundZoom',
  'footerDescription', 'footerCopyright', 'footerQuickLinksTitle', 'footerContactTitle',
  'showFooter', 'showFooterQuickLinks', 'showFooterContact',
  'navHomeLabel', 'navServicesLabel', 'navPricingLabel', 'navAboutLabel',
  'navTeamLabel', 'navGalleryLabel', 'navTestimonialsLabel',
  'navBookingLabel', 'navFaqLabel', 'navContactLabel',
  'contactCardTitle', 'contactCardBody',
  'aboutAddressLabel', 'aboutPhoneLabel',
  'footerLinkBookLabel', 'footerLinkBookingsLabel', 'footerLinkAboutLabel',
  'footerLinkServicesLabel', 'footerLinkContactLabel', 'footerLinkSignInLabel',
  'inactiveNoticeTitle', 'inactiveNoticeBody',
  'aboutEyebrow', 'aboutHighlights',
  'servicesEyebrow', 'servicesTitle',
  'teamEyebrow', 'teamMemberLabel',
  'testimonialsEyebrow', 'testimonialsTitle',
  'contactEyebrow',
  'sectionOrder',
  'hiddenSections',
  'layoutText',
  'customPrimary', 'customBg', 'customSurface',
  'customText', 'customMuted', 'customAccent',
  // Gallery + FAQ (Design Spec v1.0 pages 9 & 12)
  'showGallery', 'galleryEyebrow', 'galleryTitle', 'gallerySub', 'galleryItems',
  'showFaq', 'faqEyebrow', 'faqTitle', 'faqIntro', 'faqItems',
  // Decoupled CMS Services + Team (homepage display, independent of booking-side Service[] / User[])
  'cmsServices', 'cmsTeam',
  // Cross-vertical document/letterhead engine (prescriptions, reports, certificates, quotes)
  'letterheadSettings',
  'letterhead2Settings',
  'followUpSettings',
  // Booking (Design Spec v1.0 page 11)
  'showBooking', 'bookingEyebrow', 'bookingTitle', 'bookingSub', 'bookingCta',
  // Contact / enquiry form copy
  'enquiryFormTitle', 'enquiryFormBody', 'enquiryFormCta',
  'enquiryThanksTitle', 'enquiryThanksBody',
  // Blog page layout toggles
  'showBlogServices', 'showBlogAbout', 'showBlogTestimonials', 'showBlogContact',
]);

function getWritableBusinessContentFields() {
  const model = Prisma.dmmf?.datamodel?.models?.find((m) => m.name === 'BusinessContent');
  if (!model) return new Set(CONTENT_FIELDS);
  const nonWritable = new Set(['id', 'businessId', 'business', 'createdAt', 'updatedAt']);
  return new Set(
    model.fields
      .filter((field) => !nonWritable.has(field.name) && field.kind !== 'object')
      .map((field) => field.name)
  );
}

const WRITABLE_BUSINESS_CONTENT_FIELDS = getWritableBusinessContentFields();
const NAVBAR_TAGLINE_MAX_LENGTH = 48;
const SOCIAL_CONTENT_FIELDS = [
  { network: 'facebook', urlKey: 'socialFacebook', showKey: 'showSocialFacebook', hosts: ['facebook.com', 'fb.com'] },
  { network: 'instagram', urlKey: 'socialInstagram', showKey: 'showSocialInstagram', hosts: ['instagram.com'] },
  { network: 'twitter', urlKey: 'socialTwitter', showKey: 'showSocialTwitter', hosts: ['x.com', 'twitter.com'] },
  { network: 'linkedin', urlKey: 'socialLinkedin', showKey: 'showSocialLinkedin', hosts: ['linkedin.com'] },
  { network: 'youtube', urlKey: 'socialYoutube', showKey: 'showSocialYoutube', hosts: ['youtube.com', 'youtu.be'] },
];

function clampNavbarTagline(value) {
  if (typeof value !== 'string') return value;
  return value.trim().slice(0, NAVBAR_TAGLINE_MAX_LENGTH);
}

function hasProtocol(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function looksLikeUrl(value) {
  return hasProtocol(value) || /^[a-z0-9.-]+\.[a-z]{2,}(?:[/?#:]|$)/i.test(value);
}

function parseHttpUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const candidate = hasProtocol(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!url.hostname || !url.hostname.includes('.')) return null;
    return url;
  } catch {
    return null;
  }
}

function socialHostMatches(field, hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return field.hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function hasProfilePath(url) {
  const path = url.pathname.replace(/\/+$/, '');
  return Boolean(path && path !== '/');
}

function socialHandleToUrl(network, handle) {
  if (network === 'facebook') return `https://facebook.com/${handle}`;
  if (network === 'instagram') return `https://instagram.com/${handle}`;
  if (network === 'twitter') return `https://x.com/${handle}`;
  if (network === 'linkedin') return `https://linkedin.com/company/${handle}`;
  if (network === 'youtube') return `https://youtube.com/@${handle.replace(/^@/, '')}`;
  return null;
}

function cleanSocialHandle(value) {
  const handle = value.trim().replace(/^@/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!handle || /\s/.test(handle) || /[?#]/.test(handle)) return null;
  return handle;
}

function normalizeSocialContentUrl(field, value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  if (looksLikeUrl(trimmed)) {
    const url = parseHttpUrl(trimmed);
    if (!url || !socialHostMatches(field, url.hostname) || !hasProfilePath(url)) return null;
    return url.toString();
  }

  const handle = cleanSocialHandle(trimmed);
  const fallback = handle ? socialHandleToUrl(field.network, handle) : null;
  const url = fallback ? parseHttpUrl(fallback) : null;
  return url?.toString() || null;
}

function normalizeSocialContentData(data) {
  for (const field of SOCIAL_CONTENT_FIELDS) {
    if (data[field.urlKey] === undefined) continue;
    const normalized = normalizeSocialContentUrl(field, data[field.urlKey]);
    if (normalized) {
      data[field.urlKey] = normalized;
      if (data[field.showKey] !== undefined) data[field.showKey] = data[field.showKey] === true;
    } else {
      data[field.urlKey] = null;
      data[field.showKey] = false;
    }
  }
  return data;
}

function pickBusinessContentData(body = {}) {
  const data = {};
  for (const key of CONTENT_FIELDS) {
    if (body[key] !== undefined && WRITABLE_BUSINESS_CONTENT_FIELDS.has(key)) {
      data[key] = body[key];
    }
  }
  if (data.tagline !== undefined) data.tagline = clampNavbarTagline(data.tagline);
  return normalizeSocialContentData(data);
}

async function updateContent(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  // Pick only known fields that are also present in the generated Prisma
  // model. This keeps content autosave forward-compatible during rolling
  // deploys when the UI may send a new optional field before every backend
  // instance has the matching Prisma client/schema.
  const data = pickBusinessContentData(req.body);

  const content = await prisma.businessContent.upsert({
    where: { businessId: req.user.businessId },
    update: data,
    create: { businessId: req.user.businessId, ...data },
  });

  // Sensitive action — audit when branding (logo/favicon/tagline/banner) changed
  // (best-effort, tenant-scoped). Plain content edits aren't security-sensitive.
  const changedBranding = Object.keys(data).filter((k) => BRANDING_KEYS.has(k));
  if (changedBranding.length) {
    await writeAudit({
      businessId: req.user.businessId,
      actorId: req.user.id,
      action: 'branding.change',
      entityType: 'BusinessContent',
      entityId: req.user.businessId,
      meta: { changed: changedBranding },
    });
  }

  res.json({ content });
}

// GET /api/business/customers
// Lists every customer of the signed-in business with a lightweight
// aggregate per customer — lifetime visits / spend / no-shows, last
// visit, next upcoming appointment. Powers the "Customers" tab in the
// business admin. Capped at 500 rows for now; larger tenants will need
// a paginated version.
async function listCustomers(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  const customers = await prisma.customer.findMany({
    where: { businessId: req.user.businessId },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { id: true, name: true, email: true, phone: true, createdAt: true },
  });
  if (customers.length === 0) return res.json({ customers: [] });

  const customerIds = customers.map((c) => c.id);
  const appointments = await prisma.appointment.findMany({
    where: { customerId: { in: customerIds }, businessId: req.user.businessId },
    select: {
      customerId: true,
      date: true,
      startTime: true,
      status: true,
      finalPrice: true,
      service: { select: { price: true } },
    },
  });

  const nowMs = Date.now();
  const by = new Map();
  for (const c of customers) {
    by.set(c.id, { visits: 0, lastVisit: null, totalSpend: 0, noShows: 0, nextUpcoming: null });
  }
  for (const a of appointments) {
    const agg = by.get(a.customerId);
    if (!agg) continue;
    const price = (a.finalPrice != null ? Number(a.finalPrice) : Number(a.service?.price || 0)) || 0;
    if (a.status === 'COMPLETED') {
      agg.visits += 1;
      agg.totalSpend += price;
      if (!agg.lastVisit || new Date(a.date) > new Date(agg.lastVisit)) agg.lastVisit = a.date;
    } else if (a.status === 'NO_SHOW') {
      agg.noShows += 1;
    } else if ((a.status === 'PENDING' || a.status === 'CONFIRMED') && new Date(a.date).getTime() + 24 * 60 * 60 * 1000 >= nowMs) {
      if (!agg.nextUpcoming || new Date(a.date) < new Date(agg.nextUpcoming.date)) {
        agg.nextUpcoming = { date: a.date, startTime: a.startTime, status: a.status };
      }
    }
  }

  const list = customers.map((c) => ({ ...c, stats: by.get(c.id) }));
  res.json({ customers: list });
}

// GET /api/business/customers/:customerId/history
// Returns the customer's past appointments at THIS business, plus a small
// summary (total visits / last visit / average spend). Usable by:
//   • BUSINESS_ADMIN of the business the customer belongs to
//   • STAFF of that business who has served this customer at least once
// Anything else → 403. Never leaks a customer belonging to a different
// business.
async function getCustomerHistory(req, res) {
  const { customerId } = req.params;
  if (!req.user.businessId) return res.status(403).json({ message: 'No business' });

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, name: true, email: true, phone: true, businessId: true, createdAt: true },
  });
  if (!customer || customer.businessId !== req.user.businessId) {
    return res.status(404).json({ message: 'Customer not found' });
  }

  // Staff authorization: must have served this customer at least once.
  if (req.user.role === ROLES.STAFF) {
    const canViewAcrossDesk = userCan(req.user, 'canViewEmployees');
    if (!canViewAcrossDesk) {
      const anyShared = await prisma.appointment.findFirst({
        where: { customerId: customer.id, staffId: req.user.id },
        select: { id: true },
      });
      if (!anyShared) return res.status(403).json({ message: 'Not authorised' });
    }
  }

  const appointments = await prisma.appointment.findMany({
    where: { customerId: customer.id, businessId: req.user.businessId },
    select: {
      id: true, date: true, startTime: true, endTime: true, status: true,
      finalPrice: true, notes: true,
      service: { select: { name: true, price: true } },
      staff:   { select: { id: true, name: true } },
    },
    orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
    take: 30,
  });

  const completed = appointments.filter((a) => a.status === 'COMPLETED');
  const totalSpend = completed.reduce((s, a) => s + (a.finalPrice ?? a.service?.price ?? 0), 0);

  res.json({
    customer,
    appointments,
    stats: {
      totalVisits: completed.length,
      lastVisit:   completed[0]?.date || null,
      totalSpend,
      avgSpend:    completed.length > 0 ? Math.round(totalSpend / completed.length) : 0,
      noShows:     appointments.filter((a) => a.status === 'NO_SHOW').length,
    },
  });
}

// PATCH /api/business/settings
// Updates business-level settings that don't fit a dedicated endpoint.
// Currently: defaultLanguage. Validation happens via Zod
// (updateBusinessSettingsSchema) at the route layer.
async function updateSettings(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const {
    defaultLanguage, defaultCurrency,
    announcementBarEnabled, announcementBarText, announcementBarBgColor, announcementBarTextColor,
    wishlistEnabled, wishlistIconType, categoryGridDisplay,
    categoryMaxDepth,
    paymentMode, pickupEnabled,
    multiStoreMode, deliveryMode,
    flatDeliveryFeeMinor, flatFreeDeliveryThresholdMinor, deliveryEtaMinutes,
    featureFlags,
  } = req.body;
  const data = {};
  if (defaultLanguage !== undefined) {
    data.defaultLanguage = defaultLanguage || null;
  }
  if (defaultCurrency !== undefined) {
    // Currency can be changed freely (the old 90-day cooldown was removed).
    data.defaultCurrency = (defaultCurrency || '').toUpperCase() || null;
  }
  if (announcementBarEnabled !== undefined) data.announcementBarEnabled = !!announcementBarEnabled;
  if (announcementBarText !== undefined) data.announcementBarText = announcementBarText || null;
  if (announcementBarBgColor !== undefined) data.announcementBarBgColor = announcementBarBgColor || '#146A39';
  if (announcementBarTextColor !== undefined) data.announcementBarTextColor = announcementBarTextColor || '#ffffff';
  if (wishlistEnabled !== undefined) data.wishlistEnabled = !!wishlistEnabled;
  if (wishlistIconType !== undefined && ['bookmark', 'heart'].includes(wishlistIconType)) {
    data.wishlistIconType = wishlistIconType;
  }
  if (categoryGridDisplay !== undefined && ['main', 'sub', 'leaf'].includes(categoryGridDisplay)) {
    data.categoryGridDisplay = categoryGridDisplay;
  }
  // categoryMaxDepth — Phase E of the 3-level category rollout. Lowering
  // the depth never destroys data; the categoryDepth.js helper will
  // simply hide categories deeper than the new cap from the picker
  // until the seller upgrades back. Backend re-validates every category
  // create/move against this cap so existing-deeper data stays in
  // place but new operations honour the new ceiling.
  if (typeof categoryMaxDepth === 'number') {
    if (categoryMaxDepth < 1 || categoryMaxDepth > 5) {
      return res.status(400).json({ message: 'categoryMaxDepth must be between 1 and 5' });
    }
    data.categoryMaxDepth = categoryMaxDepth;
  }
  // Per-tenant feature overrides. Admin can toggle LIVE catalog features,
  // but roadmap/foundation items are informational only until their
  // end-to-end UI is complete. We only accept keys that exist in the
  // catalog (silently drop unknown ones) and coerce values to boolean.
  if (featureFlags !== undefined) {
    const { FEATURE_CATALOG, featureAppliesToVertical, rolloutIsLive } = require('../lib/featuresCatalog');
    if (featureFlags === null) {
      data.featureFlags = null;
    } else if (typeof featureFlags !== 'object' || Array.isArray(featureFlags)) {
      return res.status(400).json({ message: 'featureFlags must be an object of { featureKey: boolean }' });
    } else {
      const businessForFeatureScope = await prisma.business.findUnique({
        where: { id: req.user.businessId },
        select: { vertical: true },
      });
      if (!businessForFeatureScope) return res.status(404).json({ message: 'Business not found' });
      const sanitised = {};
      for (const [key, value] of Object.entries(featureFlags)) {
        const meta = FEATURE_CATALOG[key];
        if (!meta) continue; // unknown key — drop
        if (!featureAppliesToVertical(meta, businessForFeatureScope?.vertical)) continue; // hidden for this vertical
        if (!rolloutIsLive(meta.rolloutStatus)) continue; // not seller-controllable yet
        sanitised[key] = Boolean(value);
      }
      data.featureFlags = sanitised;
    }
  }
  // Storefront payment-mode policy. Locks the storefront to one of three
  // postures: BOTH (default), COD_ONLY, PREPAID_ONLY. checkout enforces.
  if (paymentMode !== undefined) {
    const mode = String(paymentMode || '').toUpperCase();
    if (!['BOTH', 'COD_ONLY', 'PREPAID_ONLY'].includes(mode)) {
      return res.status(400).json({ message: "paymentMode must be 'BOTH', 'COD_ONLY', or 'PREPAID_ONLY'" });
    }
    if (mode !== 'COD_ONLY') {
      const business = await prisma.business.findUnique({
        where: { id: req.user.businessId },
        select: { id: true, country: true, defaultCurrency: true },
      });
      if (!business) return res.status(404).json({ message: 'Business not found' });
      const currency = getDefaultCurrency({ business });
      const routeProbe = buildTenantPaymentReadiness({
        business,
        currency,
        account: null,
        providerConfigured: true,
      });
      const account = await prisma.businessPaymentAccount.findUnique({
        where: {
          businessId_provider: {
            businessId: req.user.businessId,
            provider: routeProbe.provider,
          },
        },
        select: { provider: true, accountId: true, status: true },
      });
      const readiness = buildTenantPaymentReadiness({
        business,
        currency,
        account,
        providerConfigured: tenantProviderConfigured(routeProbe.provider),
      });
      const block = onlineModeBlock({ paymentMode: mode, readiness });
      if (block) return res.status(409).json(block);
    }
    data.paymentMode = mode;
  }
  if (pickupEnabled !== undefined) data.pickupEnabled = !!pickupEnabled;
  // ECOMMERCE multi-store / multi-region mode (2026-05-12) — tenant-level
  // switch read by the storefront LocationGate.
  if (multiStoreMode !== undefined) {
    const mode = String(multiStoreMode || '').toUpperCase();
    if (!['OFF', 'FULFILLMENT', 'CHAIN', 'REGIONAL', 'BOTH'].includes(mode)) {
      return res.status(400).json({ message: "multiStoreMode must be 'OFF', 'FULFILLMENT', 'CHAIN', 'REGIONAL', or 'BOTH'" });
    }
    // Branch modes (several customer-facing stores) need the multi-branch
    // entitlement — the first 3 ecom plans include a single branch (Shopify-
    // style). Mirror the Store Setup UI lock so the API can't bypass the plan.
    if (['CHAIN', 'REGIONAL', 'BOTH'].includes(mode)) {
      const ent = await numericEntitlement(req.user.businessId, 'branches_count').catch(() => null);
      const allowsMultiBranch = ent && (ent.unlimited || Number(ent.limit) > 1);
      if (!allowsMultiBranch) {
        return res.status(402).json({
          message: 'Selling from several branches is on the Business plan. Upgrade in Billing & Plan to unlock multi-branch.',
          code: 'plan_upgrade_required',
          entitlement: ent || null,
        });
      }
    }
    data.multiStoreMode = mode;
  }
  // Home-delivery model (2026-06-06). Drives the storefront slot picker and
  // the Store Setup window's "delivery times" section.
  if (deliveryMode !== undefined) {
    const mode = String(deliveryMode || '').toUpperCase();
    if (!['SCHEDULED', 'ASAP', 'NONE'].includes(mode)) {
      return res.status(400).json({ message: "deliveryMode must be 'SCHEDULED', 'ASAP', or 'NONE'" });
    }
    data.deliveryMode = mode;
  }
  // Store-level flat delivery (deliver-anywhere rate). Minor units, server-side.
  if (flatDeliveryFeeMinor !== undefined) {
    const v = Number(flatDeliveryFeeMinor);
    if (!Number.isInteger(v) || v < 0) return res.status(400).json({ message: 'flatDeliveryFeeMinor must be a whole number ≥ 0' });
    data.flatDeliveryFeeMinor = v;
  }
  if (flatFreeDeliveryThresholdMinor !== undefined) {
    const v = Number(flatFreeDeliveryThresholdMinor);
    if (!Number.isInteger(v) || v < 0) return res.status(400).json({ message: 'flatFreeDeliveryThresholdMinor must be a whole number ≥ 0' });
    data.flatFreeDeliveryThresholdMinor = v;
  }
  if (deliveryEtaMinutes !== undefined) {
    if (deliveryEtaMinutes === null || deliveryEtaMinutes === '') {
      data.deliveryEtaMinutes = null;
    } else {
      const v = Number(deliveryEtaMinutes);
      if (!Number.isInteger(v) || v < 0) return res.status(400).json({ message: 'deliveryEtaMinutes must be a whole number ≥ 0' });
      data.deliveryEtaMinutes = v;
    }
  }
  // Fulfilment guard — a store must always keep at least one way to fulfil
  // orders. Block turning delivery off (NONE) while pickup is (or would be)
  // off too. Only reads the DB when one of the two is being tightened.
  if (data.deliveryMode === 'NONE' || data.pickupEnabled === false) {
    const current = await prisma.business.findUnique({
      where: { id: req.user.businessId },
      select: { deliveryMode: true, pickupEnabled: true },
    });
    const finalDelivery = data.deliveryMode ?? current?.deliveryMode ?? 'ASAP';
    const finalPickup = data.pickupEnabled ?? current?.pickupEnabled ?? false;
    if (finalDelivery === 'NONE' && !finalPickup) {
      return res.status(400).json({
        message: 'Turn on pickup before switching off home delivery — a store needs at least one way to fulfil orders.',
      });
    }
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: 'No settings to update' });
  }
  const updated = await prisma.business.update({
    where: { id: req.user.businessId },
    data,
    select: {
      id: true, defaultLanguage: true, defaultCurrency: true, currencyChangedAt: true,
      announcementBarEnabled: true, announcementBarText: true,
      announcementBarBgColor: true, announcementBarTextColor: true,
      wishlistEnabled: true, wishlistIconType: true,
      categoryGridDisplay: true,
      categoryMaxDepth: true,
      paymentMode: true, pickupEnabled: true,
      multiStoreMode: true, deliveryMode: true,
      featureFlags: true,
    },
  });
  res.json({ business: updated });
}

// GET /api/business/email-deliveries
// Recent delivery history for the signed-in business admin.
async function listEmailDeliveries(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  const status = String(req.query.status || '').trim().toUpperCase();
  const eventKey = String(req.query.eventKey || '').trim();
  const recipient = String(req.query.recipient || '').trim().toLowerCase();
  const take = parsePageSize(req.query.limit, 25, 100);

  const where = {
    businessId: req.user.businessId,
    ...(status ? { status } : {}),
    ...(eventKey ? { eventKey } : {}),
    ...(recipient ? { recipientEmail: { contains: recipient, mode: 'insensitive' } } : {}),
  };

  const [deliveries, totals] = await Promise.all([
    prisma.emailDelivery.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        eventKey: true,
        category: true,
        provider: true,
        senderEmail: true,
        recipientEmail: true,
        actualRecipientEmail: true,
        recipientName: true,
        subject: true,
        status: true,
        appointmentId: true,
        userId: true,
        customerId: true,
        subscriptionId: true,
        metadata: true,
        providerMessageId: true,
        errorMessage: true,
        overrideApplied: true,
        attemptedAt: true,
        sentAt: true,
        createdAt: true,
      },
    }),
    prisma.emailDelivery.groupBy({
      by: ['status'],
      where: { businessId: req.user.businessId },
      _count: { status: true },
    }),
  ]);

  const summary = {
    pending: 0,
    sent: 0,
    failed: 0,
  };
  totals.forEach((row) => {
    if (row.status === 'PENDING') summary.pending = row._count.status;
    if (row.status === 'SENT') summary.sent = row._count.status;
    if (row.status === 'FAILED') summary.failed = row._count.status;
  });

  res.json({
    deliveries,
    summary,
    filters: {
      status: status || null,
      eventKey: eventKey || null,
      recipient: recipient || null,
      limit: take,
    },
  });
}

// GET /api/business/vertical-impact?target=<STATIC|APPOINTMENT|ECOMMERCE>
//
// Business type is account identity now. The endpoint remains for old clients
// and returns a clean 409 instead of letting a tenant switch verticals.
async function verticalImpact(req, res) {
  const businessId = req.user.businessId;
  const target = String(req.query.target || '').toUpperCase();
  if (!['STATIC', 'APPOINTMENT', 'ECOMMERCE'].includes(target)) {
    return res.status(400).json({ message: 'target must be STATIC, APPOINTMENT, or ECOMMERCE' });
  }

  const biz = await prisma.business.findUnique({
    where: { id: businessId },
    select: { vertical: true, slug: true },
  });
  if (!biz) return res.status(404).json({ message: 'Business not found' });
  const current = (biz.vertical || 'APPOINTMENT').toUpperCase();
  if (current === target) {
    return res.json({
      currentVertical: current, targetVertical: target,
      hidden: {}, gained: [], customerImpact: null, noOp: true,
    });
  }

  return res.status(409).json({
    code: 'vertical_switch_disabled',
    message: 'Business type is locked for this account. Create a new account for another business type, or delete this business and start again.',
    currentVertical: current,
    targetVertical: target,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// GDPR Article 17 — owner-initiated business deletion (soft-delete + 30-day
// grace). See backend/src/core/lib/accountDeletion.js for the cron purge.
// ───────────────────────────────────────────────────────────────────────────
async function requestDeletion(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'No business linked to your account' });
  }
  const { reason } = req.body || {};
  const accountDeletion = require('../lib/accountDeletion');
  const { business, alreadyPending, purgeAt } = await accountDeletion.requestBusinessDeletion({
    businessId: req.user.businessId,
    actorUserId: req.user.id,
    ipAddress: req.ip,
    userAgent: req.get('User-Agent') || null,
    reason: reason || null,
  });
  res.json({
    pending: true,
    alreadyPending: !!alreadyPending,
    purgeAt: purgeAt || null,
    businessId: business.id,
  });
}

async function undoDeletion(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'No business linked to your account' });
  }
  const accountDeletion = require('../lib/accountDeletion');
  const restored = await accountDeletion.undoBusinessDeletion({
    businessId: req.user.businessId,
    ipAddress: req.ip,
    userAgent: req.get('User-Agent') || null,
  });
  if (!restored) return res.status(404).json({ message: 'No pending deletion to undo' });
  res.json({ pending: false });
}

// GET /api/business/feature-flags — drives the admin Features Settings panel.
// Returns the full catalog (filtered to the tenant's vertical), the raw
// admin overrides currently saved, AND the resolved effective state per
// feature so the UI can render with-/without-override visualisation in a
// single round-trip. Plan-gate info comes through `planRequired` on each
// catalog entry + `tier` at the top level so the UI can render "Upgrade
// to enable" badges without a second lookup.
async function getFeatureFlags(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const { catalogForVertical } = require('../lib/featuresCatalog');
  const { resolveFeatures } = require('./tenant.controller');
  const business = await prisma.business.findUnique({
    where: { id: req.user.businessId },
    select: {
      id: true, vertical: true, featureFlags: true,
      subscription: { select: { status: true, tierId: true, tier: { select: { name: true, slug: true } } } },
    },
  });
  if (!business) return res.status(404).json({ message: 'Business not found' });
  const catalog = catalogForVertical(business.vertical);
  const effective = await resolveFeatures(business);
  const adminOverrides = Object.fromEntries(
    Object.entries(business.featureFlags || {}).filter(([key]) => catalog[key]),
  );
  res.json({
    vertical: business.vertical,
    tier: business.subscription?.tier || null,
    catalog,
    adminOverrides,
    effective: Object.fromEntries(Object.keys(catalog).map((k) => [k, !!effective[k]])),
  });
}

// Doctor v2 — appointment reminder config (Business.appointmentReminderConfig).
async function getReminderConfig(req, res) {
  const businessId = req.user.businessId;
  if (!businessId) return res.status(400).json({ message: 'No business' });
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { appointmentReminderConfig: true } });
  res.json({ config: b?.appointmentReminderConfig || { enabled: true } });
}
async function updateReminderConfig(req, res) {
  const businessId = req.user.businessId;
  if (!businessId) return res.status(400).json({ message: 'No business' });
  const config = { enabled: req.body?.enabled !== false };
  await prisma.business.update({ where: { id: businessId }, data: { appointmentReminderConfig: config } });
  res.json({ config });
}

// ── Feature 1: tenant users + role assignment ──────────────────────────────
// Vertical-agnostic list of the tenant's operator users (BUSINESS_ADMIN / STAFF)
// with their assigned BusinessRole. Powers the People→role-assignment table in
// settings/roles. listStaff is gated to appointment/ecommerce verticals, so HR
// tenants need this plain, tenant-scoped read.
async function listBusinessUsers(req, res) {
  const businessId = req.user?.businessId;
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const users = await prisma.user.findMany({
    where: { businessId, role: { in: [ROLES.BUSINESS_ADMIN, ROLES.STAFF] } },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      businessRoleId: true,
      businessRole: { select: { id: true, name: true, isSystem: true } },
    },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
  });
  res.json({ users });
}

// PATCH /api/business/users/:id/role { businessRoleId } — assign a BusinessRole
// to a tenant User. The role must belong to the same business. "Last Owner"
// guard (AC-HR7): refuse (409) if this change would leave the tenant with no
// user holding the Owner role / BUSINESS_ADMIN admin authority.
async function assignUserRole(req, res) {
  const businessId = req.user?.businessId;
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });

  const targetId = req.params.id;
  // Allow null/empty to clear the custom role (fall back to legacy enum perms).
  const raw = req.body?.businessRoleId;
  const businessRoleId = raw === '' || raw === undefined ? null : raw;

  const target = await prisma.user.findFirst({
    where: { id: targetId, businessId },
    select: {
      id: true,
      role: true,
      businessRoleId: true,
      businessRole: { select: { id: true, name: true } },
    },
  });
  if (!target) return res.status(404).json({ message: 'Not found' });

  let nextRole = null;
  if (businessRoleId) {
    nextRole = await prisma.businessRole.findFirst({
      where: { id: businessRoleId, businessId },
      select: { id: true, name: true },
    });
    // Role missing or belongs to another tenant — never leak existence.
    if (!nextRole) return res.status(404).json({ message: 'Not found' });
  }

  // "Last Owner" guard. A user has Owner authority if they hold the system
  // "Owner" BusinessRole OR carry the legacy BUSINESS_ADMIN enum. If this user
  // is currently an Owner and the change removes that authority, ensure at least
  // one other Owner remains.
  const wasOwner =
    target.role === ROLES.BUSINESS_ADMIN || target.businessRole?.name === 'Owner';
  const willBeOwner =
    target.role === ROLES.BUSINESS_ADMIN || nextRole?.name === 'Owner';
  if (wasOwner && !willBeOwner) {
    const otherOwners = await prisma.user.count({
      where: {
        businessId,
        id: { not: targetId },
        OR: [{ role: ROLES.BUSINESS_ADMIN }, { businessRole: { name: 'Owner' } }],
      },
    });
    if (otherOwners === 0) {
      return res
        .status(409)
        .json({ message: 'Cannot remove the last Owner. Assign another Owner first.' });
    }
  }

  const updated = await prisma.user.update({
    where: { id: targetId },
    data: { businessRoleId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      businessRoleId: true,
      businessRole: { select: { id: true, name: true, isSystem: true } },
    },
  });

  await writeAudit({
    businessId,
    actorId: req.user?.id,
    action: 'role.change',
    entityType: 'User',
    entityId: targetId,
    meta: {
      op: 'assign',
      before: { businessRoleId: target.businessRoleId, name: target.businessRole?.name || null },
      after: { businessRoleId: updated.businessRoleId, name: updated.businessRole?.name || null },
    },
  });

  res.json({ user: updated });
}

module.exports = {
  checkSlug,
  setup,
  changeSlug,
  getDomainConfig,
  getMyBusiness,
  getMyBusinessContext,
  listBusinessUsers,
  assignUserRole,
  inviteStaff,
  quickAddStaff,
  listStaff,
  updateStaff,
  removeStaff,
  getContent,
  updateContent,
  getReminderConfig,
  updateReminderConfig,
  listCustomers,
  getCustomerHistory,
  listEmailDeliveries,
  updateSettings,
  verticalImpact,
  requestDeletion,
  undoDeletion,
  getFeatureFlags,
  _private: {
    CONTENT_FIELDS,
    WRITABLE_BUSINESS_CONTENT_FIELDS,
    pickBusinessContentData,
    normalizeSocialContentUrl,
  },
};
