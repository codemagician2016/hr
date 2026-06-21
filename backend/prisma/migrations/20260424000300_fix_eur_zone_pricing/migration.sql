-- Fix EUR TierPrice rows that previously used a flat €17/€54/€179 for every
-- EUR country regardless of zone. Apply zone-aware pricing:
--   Zone 1 EUR (IE, FI, NL, DE, FR, BE, AT, LU, AD, MC, SM, VA): €17/€54/€179  (unchanged — already correct)
--   Zone 2 EUR (ES, IT, PT, GR, SK, SI, EE, LT, LV, CY, MT, GF, GP, MQ):       €14/€46/€152
--   Zone 3 EUR (HR, ME, XK):                                                   €11/€35/€116
-- Annual = monthly × 9.6 (20% annual discount, per seed/pricing.seed.js).
-- Amounts are stored in minor units (EUR × 100).

-- Zone 2 EUR — Starter
UPDATE "TierPrice" tp SET "amountMonthlyMinor" = 1400, "amountAnnualMinor" = 13440, "updatedAt" = NOW()
FROM "PricingTier" pt
WHERE tp."tierId" = pt.id AND pt.slug = 'starter'
  AND tp."countryCode" IN ('ES','IT','PT','GR','SK','SI','EE','LT','LV','CY','MT','GF','GP','MQ');

-- Zone 2 EUR — Professional
UPDATE "TierPrice" tp SET "amountMonthlyMinor" = 4600, "amountAnnualMinor" = 44160, "updatedAt" = NOW()
FROM "PricingTier" pt
WHERE tp."tierId" = pt.id AND pt.slug = 'professional'
  AND tp."countryCode" IN ('ES','IT','PT','GR','SK','SI','EE','LT','LV','CY','MT','GF','GP','MQ');

-- Zone 2 EUR — Business
UPDATE "TierPrice" tp SET "amountMonthlyMinor" = 15200, "amountAnnualMinor" = 145920, "updatedAt" = NOW()
FROM "PricingTier" pt
WHERE tp."tierId" = pt.id AND pt.slug = 'business'
  AND tp."countryCode" IN ('ES','IT','PT','GR','SK','SI','EE','LT','LV','CY','MT','GF','GP','MQ');

-- Zone 3 EUR — Starter
UPDATE "TierPrice" tp SET "amountMonthlyMinor" = 1100, "amountAnnualMinor" = 10560, "updatedAt" = NOW()
FROM "PricingTier" pt
WHERE tp."tierId" = pt.id AND pt.slug = 'starter'
  AND tp."countryCode" IN ('HR','ME','XK');

-- Zone 3 EUR — Professional
UPDATE "TierPrice" tp SET "amountMonthlyMinor" = 3500, "amountAnnualMinor" = 33600, "updatedAt" = NOW()
FROM "PricingTier" pt
WHERE tp."tierId" = pt.id AND pt.slug = 'professional'
  AND tp."countryCode" IN ('HR','ME','XK');

-- Zone 3 EUR — Business
UPDATE "TierPrice" tp SET "amountMonthlyMinor" = 11600, "amountAnnualMinor" = 111360, "updatedAt" = NOW()
FROM "PricingTier" pt
WHERE tp."tierId" = pt.id AND pt.slug = 'business'
  AND tp."countryCode" IN ('HR','ME','XK');
