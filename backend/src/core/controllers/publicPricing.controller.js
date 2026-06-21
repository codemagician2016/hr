const prisma = require('../lib/prisma');
const { ensurePricingReferenceData } = require('../lib/pricingReferenceSync');

// Public pricing endpoint. Resolves per-country prices from the PricingTier /
// TierPrice / CountryZoneAssignment / PricingZone tables. Mounted at
// /api/public/pricing — anonymous, no auth, safe to call from any frontend.

const ZERO_DEC  = new Set(['JPY','KRW','VND','CLP','ISK','HUF','COP','IDR','PYG','UGX','RWF','XAF','XOF','KMF','DJF','GNF','BIF']);
const THREE_DEC = new Set(['KWD','BHD','OMR','JOD','TND','IQD','LYD']);
const CARD_REQUIRED_TRIAL_DAYS = Number.parseInt(process.env.PADDLE_TRIAL_DAYS || '30', 10) || 30;

function normalizePublicTrialCopy(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/Start\s+14-day\s+trial/gi, `Start ${CARD_REQUIRED_TRIAL_DAYS}-day trial`)
    .replace(/14-day\s+trial/gi, `${CARD_REQUIRED_TRIAL_DAYS}-day trial`)
    .replace(/no\s+credit\s+card\s+(needed|required)/gi, 'card required');
}

function minorToMajor(minor, currency) {
  if (minor == null) return 0;
  if (ZERO_DEC.has(currency))  return minor;
  if (THREE_DEC.has(currency)) return minor / 1000;
  return minor / 100;
}

// Gateway checkouts require a payment method when a plan has trialDays set.
// The length is now per PricingTier; this object only preserves the shared
// card-required semantics for older clients.
const PUBLIC_TRIAL = { days: CARD_REQUIRED_TRIAL_DAYS, requiresCard: true };

// Fallback used only if the PricingTier table is empty. Should not happen in
// prod after seeds/pricing.seed.js has run.
const FALLBACK_PRICING = {
  defaultRegion: 'IN',
  trial: PUBLIC_TRIAL,
  regions: [{
    code: 'IN', name: 'India', currency: 'INR', symbol: '₹',
    plans: {
      starter:      { monthly: 499,  yearly: 4790,  extraStaffMonthly: 0 },
      professional: { monthly: 1499, yearly: 14390, extraStaffMonthly: 249 },
      business:     { monthly: 3999, yearly: 38390, extraStaffMonthly: 0 },
    },
  }],
  tiers: [],
};

async function resolveCountryPricing(countryCode, vertical = null) {
  // Vertical-aware filtering — STATIC / ECOMMERCE customers should see
  // tiers configured for their vertical, not appointment-only plans.
  // PricingTier.vertical default is 'APPOINTMENT'. If the requested
  // vertical has no tiers seeded yet (early days for ECOMMERCE/STATIC),
  // fall back to APPOINTMENT tiers so signup never dead-ends. The fallback
  // gets removed once the user seeds per-vertical pricing.
  // Vertical-aware: each vertical has its own set of plans (Booking /
  // Shop / Marketing). Empty result for ECOMMERCE/STATIC falls back to
  // APPOINTMENT so the page never dead-ends; missing vertical param also
  // defaults to APPOINTMENT (the master).
  const v = (vertical && ['STATIC', 'APPOINTMENT', 'ECOMMERCE'].includes(vertical)) ? vertical : 'APPOINTMENT';
  let tiers = await prisma.pricingTier.findMany({
    where: { isActive: true, vertical: v },
    orderBy: { sortOrder: 'asc' },
  });
  if (tiers.length === 0 && v !== 'APPOINTMENT') {
    tiers = await prisma.pricingTier.findMany({
      where: { isActive: true, vertical: 'APPOINTMENT' },
      orderBy: { sortOrder: 'asc' },
    });
  }
  tiers = tiers.filter((tier) => tier.slug !== 'free');
  if (tiers.length === 0) return null;

  let country = null;
  if (countryCode) {
    country = await prisma.countryZoneAssignment.findUnique({
      where: { countryCode },
      include: { zone: true },
    });
  }
  const multiplier = Number(country?.zone?.multiplier || 1);

  // SINGLE SOURCE OF TRUTH: the public price display uses the SAME 5-currency
  // canonical resolution as actual billing (resolveTierPriceRecord), so what a
  // visitor sees on the landing == what their billing charges. No zone-multiplier
  // guesswork: each country resolves to its supported currency (INR/NZD/GBP/EUR/
  // USD) via the canonical price the super-admin sets.
  const { resolveTierPriceRecord } = require('../lib/subscriptionBilling');
  const { resolvePresentmentCurrency } = require('../lib/billing/gatewayRouter');
  const CURRENCY_SYMBOL = { INR: '₹', USD: '$', EUR: '€', GBP: '£', NZD: 'NZ$', AUD: 'A$' };

  const plans = {};
  let resolvedCurrency = null;   // the currency the rows ACTUALLY resolve to
  for (const tier of tiers) {
    const row = await resolveTierPriceRecord({ tierId: tier.id, countryCode });
    if (row) {
      if (!resolvedCurrency) resolvedCurrency = row.currencyCode;
      plans[tier.slug] = {
        monthly:            minorToMajor(row.amountMonthlyMinor, row.currencyCode),
        yearly:             minorToMajor(row.amountAnnualMinor,  row.currencyCode),
        extraStaffMonthly:  minorToMajor(row.overageStaffPriceMinor || 0, row.currencyCode),
        extraBranchMonthly: minorToMajor(row.overageBranchPriceMinor || 0, row.currencyCode),
      };
    } else {
      plans[tier.slug] = { monthly: 0, yearly: 0, extraStaffMonthly: 0 };
    }
  }

  // Display the currency the price ACTUALLY resolved to — not the country's
  // presentment currency. So a country whose presentment currency has no price
  // rows yet (e.g. AUD before any AUD price is set) shows the USD fallback as USD,
  // never USD amounts mislabelled with a different symbol.
  const displayCurrency = resolvedCurrency || resolvePresentmentCurrency(countryCode) || 'USD';
  const displaySymbol   = CURRENCY_SYMBOL[displayCurrency] || country?.currencySymbol || '$';

  const effectiveCode = country?.countryCode || 'INTL';
  const effectiveName = country?.countryName || 'International';
  const pricingMode = displayCurrency !== 'USD' ? 'country_override' : 'base_usd';

  const tiersContent = tiers.map((t) => ({
    slug:           t.slug,
    name:           t.name,
    tagline:        normalizePublicTrialCopy(t.tagline),
    description:    normalizePublicTrialCopy(t.description),
    badge:          t.badge,
    features:       (t.features || []).map(normalizePublicTrialCopy),
    ctaLabel:       normalizePublicTrialCopy(t.ctaLabel),
    ctaHref:        t.ctaHref,
    highlighted:    t.highlighted,
    includedStaff:  t.includedStaff,
    includedBranches:          t.includedBranches ?? null,
    contactSalesAboveBranches: t.contactSalesAboveBranches ?? null,
    sortOrder:      t.sortOrder,
    isCustomPriced: t.isCustomPriced,
    trialDays:      t.trialDays ?? null,
  }));

  return {
    defaultRegion: effectiveCode,
    trial: PUBLIC_TRIAL,
    regions: [{
      code: effectiveCode,
      name: effectiveName,
      currency: displayCurrency,
      symbol: displaySymbol,
      pricingMode,
      multiplier,
      zone: country?.zone ? {
        slug: country.zone.slug,
        name: country.zone.name,
        multiplier: Number(country.zone.multiplier || 1),
      } : null,
      plans,
    }],
    tiers: tiersContent,
    priceSource: pricingMode,
  };
}

// GET /api/public/pricing?country=XX&vertical=APPOINTMENT|STATIC|ECOMMERCE
async function getPricing(req, res) {
  const country = (req.query.country || '').toUpperCase().slice(0, 2) || null;
  const verticalRaw = (req.query.vertical || '').toUpperCase();
  const vertical = ['STATIC', 'APPOINTMENT', 'ECOMMERCE'].includes(verticalRaw) ? verticalRaw : null;
  try {
    await ensurePricingReferenceData();
    const resolved = await resolveCountryPricing(country, vertical);
    if (resolved) return res.json({ pricing: resolved, source: 'admin' });
    return res.json({ pricing: FALLBACK_PRICING, source: 'fallback' });
  } catch (err) {
    console.error('[getPricing] error:', err);
    return res.json({ pricing: FALLBACK_PRICING, source: 'fallback' });
  }
}

module.exports = { getPricing };
