const { resolveVertical } = require('./vertical');

const PLAN_FAMILY_ORDER = ['FREE', 'SOLO', 'STARTER', 'FULFILLMENT', 'PROFESSIONAL', 'BUSINESS', 'CUSTOM'];
const PLAN_FAMILY_LABELS = {
  FREE: 'Free',
  SOLO: 'Solo',
  STARTER: 'Starter',
  FULFILLMENT: 'Fulfillment',
  PROFESSIONAL: 'Professional',
  BUSINESS: 'Business',
  CUSTOM: 'Custom',
};

function baseSlug(slug) {
  return String(slug || '').replace(/^(static|ecom)-/, '');
}

function planFamilyKeyForTier(tier) {
  const vertical = resolveVertical(tier?.vertical);
  const slug = baseSlug(tier?.slug).toLowerCase();
  const sortOrder = Number(tier?.sortOrder || 0);

  // Custom/contact-sales is driven by the isCustomPriced FLAG (the real billing
  // gate), not the slug — so any tier can be a quote tier regardless of naming.
  // The slug checks below remain only as a back-compat fallback.
  if (tier?.isCustomPriced) return 'CUSTOM';

  if (slug === 'free' && sortOrder === 0) return 'FREE';
  if (slug === 'solo') return 'SOLO';
  if (vertical === 'ECOMMERCE' && slug === 'starter') return 'FULFILLMENT';
  if (slug === 'starter') return 'STARTER';
  if (slug === 'professional' || slug === 'pro') return 'PROFESSIONAL';
  if (slug === 'business' || slug === 'enterprise') return 'BUSINESS';
  if (slug === 'custom' || slug === 'contact-sales' || slug === 'contact_sales') return 'CUSTOM';

  if (slug === 'free' && vertical === 'STATIC') return 'SOLO';
  if (slug === 'free' && vertical === 'ECOMMERCE') return 'STARTER';

  if (sortOrder <= 0) return 'FREE';
  if (sortOrder === 1) return 'SOLO';
  if (sortOrder === 2) return 'STARTER';
  if (sortOrder === 3) return 'PROFESSIONAL';
  if (sortOrder === 4) return 'BUSINESS';
  return 'CUSTOM';
}

function familyRank(familyKey) {
  const idx = PLAN_FAMILY_ORDER.indexOf(familyKey);
  return idx >= 0 ? idx : 999;
}

function tierAliasSlugs(tier) {
  const slug = String(tier?.slug || '').trim();
  if (!slug) return [];
  const aliases = new Set([slug]);
  const family = planFamilyKeyForTier(tier).toLowerCase();
  const vertical = resolveVertical(tier?.vertical);
  if (vertical === 'STATIC') aliases.add(`static-${family}`);
  if (vertical === 'ECOMMERCE') aliases.add(`ecom-${family}`);
  if (family === 'professional') aliases.add('pro');
  return [...aliases];
}

function basePriceForTier(tier) {
  const prices = Array.isArray(tier?.prices) ? tier.prices : [];
  return prices.find((price) => price.countryCode == null) || prices[0] || null;
}

function serializeCatalogTier(tier) {
  const familyKey = planFamilyKeyForTier(tier);
  const price = basePriceForTier(tier);
  const paid = !tier?.isCustomPriced && Number(price?.amountMonthlyMinor || 0) > 0;
  const monthlyId = price?.paddlePriceIdMonthly || null;
  const annualId = price?.paddlePriceIdAnnual || null;

  return {
    id: tier.id,
    slug: tier.slug,
    aliases: tierAliasSlugs(tier),
    name: tier.name,
    vertical: resolveVertical(tier.vertical),
    familyKey,
    familyLabel: PLAN_FAMILY_LABELS[familyKey] || tier.name,
    familyRank: familyRank(familyKey),
    sortOrder: Number(tier.sortOrder || 0),
    isActive: Boolean(tier.isActive),
    isCustomPriced: Boolean(tier.isCustomPriced),
    price: price ? {
      id: price.id,
      currencyCode: price.currencyCode,
      amountMonthlyMinor: price.amountMonthlyMinor,
      amountAnnualMinor: price.amountAnnualMinor,
      monthlyPriceIdConfigured: Boolean(monthlyId),
      annualPriceIdConfigured: Boolean(annualId),
    } : null,
    coverage: {
      hasBasePrice: Boolean(price),
      hasCurrency: Boolean(price?.currencyCode),
      hasPositiveMonthlyAmount: Number(price?.amountMonthlyMinor || 0) > 0,
      hasPositiveAnnualAmount: Number(price?.amountAnnualMinor || 0) > 0,
      hasMonthlyPaddlePriceId: Boolean(monthlyId),
      hasAnnualPaddlePriceId: Boolean(annualId),
      paidSelfServeReady: !paid || Boolean(price?.currencyCode && monthlyId && annualId),
    },
  };
}

function buildPlanCatalogMatrix(tiers = []) {
  const variants = tiers.map(serializeCatalogTier)
    .sort((a, b) => a.familyRank - b.familyRank || a.vertical.localeCompare(b.vertical) || a.sortOrder - b.sortOrder);
  const byFamily = new Map();
  for (const variant of variants) {
    if (!byFamily.has(variant.familyKey)) {
      byFamily.set(variant.familyKey, {
        key: variant.familyKey,
        label: variant.familyLabel,
        rank: variant.familyRank,
        variants: { APPOINTMENT: null, ECOMMERCE: null, STATIC: null },
        aliases: [],
      });
    }
    const row = byFamily.get(variant.familyKey);
    row.variants[variant.vertical] = variant;
    row.aliases.push(...variant.aliases);
  }

  return PLAN_FAMILY_ORDER.map((familyKey) => byFamily.get(familyKey) || {
    key: familyKey,
    label: PLAN_FAMILY_LABELS[familyKey],
    rank: familyRank(familyKey),
    variants: { APPOINTMENT: null, ECOMMERCE: null, STATIC: null },
    aliases: [],
  }).map((row) => ({
    ...row,
    aliases: [...new Set(row.aliases)].sort(),
    missingVerticals: Object.entries(row.variants)
      .filter(([, variant]) => !variant)
      .map(([vertical]) => vertical),
    readiness: Object.values(row.variants)
      .filter(Boolean)
      .every((variant) => variant.coverage.paidSelfServeReady),
  }));
}

module.exports = {
  PLAN_FAMILY_LABELS,
  PLAN_FAMILY_ORDER,
  buildPlanCatalogMatrix,
  familyRank,
  planFamilyKeyForTier,
  serializeCatalogTier,
  tierAliasSlugs,
};
