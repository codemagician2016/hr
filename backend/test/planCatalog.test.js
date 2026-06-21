const {
  buildPlanCatalogMatrix,
  planFamilyKeyForTier,
  tierAliasSlugs,
} = require('../src/core/lib/planCatalog');

function tier(slug, vertical, sortOrder, price = {}) {
  return {
    id: `tier_${slug}`,
    slug,
    name: slug,
    vertical,
    sortOrder,
    isActive: true,
    isCustomPriced: false,
    prices: [{
      id: `price_${slug}`,
      countryCode: null,
      currencyCode: 'USD',
      amountMonthlyMinor: 900,
      amountAnnualMinor: 9000,
      paddlePriceIdMonthly: `pri_${slug}_month`,
      paddlePriceIdAnnual: `pri_${slug}_year`,
      ...price,
    }],
  };
}

describe('plan catalog normalization', () => {
  test('maps legacy vertical slugs to canonical customer-facing families', () => {
    expect(planFamilyKeyForTier(tier('free', 'APPOINTMENT', 0))).toBe('FREE');
    expect(planFamilyKeyForTier(tier('static-free', 'STATIC', 1))).toBe('SOLO');
    expect(planFamilyKeyForTier(tier('ecom-free', 'ECOMMERCE', 1))).toBe('STARTER');
    expect(planFamilyKeyForTier(tier('ecom-starter', 'ECOMMERCE', 2))).toBe('FULFILLMENT');
    expect(planFamilyKeyForTier(tier('professional', 'APPOINTMENT', 3))).toBe('PROFESSIONAL');
    expect(planFamilyKeyForTier(tier('ecom-custom', 'ECOMMERCE', 5))).toBe('CUSTOM');
  });

  test('preserves legacy aliases for support and migration lookup', () => {
    expect(tierAliasSlugs(tier('ecom-professional', 'ECOMMERCE', 3))).toEqual(expect.arrayContaining([
      'ecom-professional',
      'pro',
    ]));
    expect(new Set(tierAliasSlugs(tier('static-free', 'STATIC', 1))).has('static-solo')).toBe(true);
  });

  test('builds a vertical matrix with missing and Paddle readiness signals', () => {
    const matrix = buildPlanCatalogMatrix([
      tier('free', 'APPOINTMENT', 0, { amountMonthlyMinor: 0, amountAnnualMinor: 0, paddlePriceIdMonthly: null, paddlePriceIdAnnual: null }),
      tier('starter', 'APPOINTMENT', 2),
      tier('ecom-free', 'ECOMMERCE', 1, { paddlePriceIdAnnual: null }),
      tier('ecom-starter', 'ECOMMERCE', 2),
      tier('static-free', 'STATIC', 1),
      tier('static-custom', 'STATIC', 5, { paddlePriceIdMonthly: null, paddlePriceIdAnnual: null }),
    ]);

    const free = matrix.find((row) => row.key === 'FREE');
    const starter = matrix.find((row) => row.key === 'STARTER');
    const fulfillment = matrix.find((row) => row.key === 'FULFILLMENT');
    const solo = matrix.find((row) => row.key === 'SOLO');
    const custom = matrix.find((row) => row.key === 'CUSTOM');

    expect(free.variants.APPOINTMENT.slug).toBe('free');
    expect(free.missingVerticals).toEqual(expect.arrayContaining(['ECOMMERCE', 'STATIC']));
    expect(starter.variants.ECOMMERCE.coverage.hasAnnualPaddlePriceId).toBe(false);
    expect(starter.readiness).toBe(false);
    expect(fulfillment.variants.ECOMMERCE.slug).toBe('ecom-starter');
    expect(solo.variants.STATIC.slug).toBe('static-free');
    expect(custom.variants.STATIC.slug).toBe('static-custom');
  });
});
