-- Backfill: the old onboarding put every new business on the generic 'free' tier
-- (vertical APPOINTMENT), so STATIC (Website) and ECOMMERCE (Commerce) accounts
-- showed the PLAN_VERTICAL_MISMATCH warning. Move them onto their vertical's free
-- tier. Only touches subscriptions currently ON the generic 'free' tier; no-op if
-- the target tier doesn't exist or there's nothing mismatched.

UPDATE "Subscription" s
   SET "tierId" = t.id
  FROM "Business" b, "PricingTier" t
 WHERE s."businessId" = b.id
   AND b."vertical" = 'STATIC'
   AND t."slug" = 'static-free'
   AND s."tierId" = (SELECT id FROM "PricingTier" WHERE "slug" = 'free');

UPDATE "Subscription" s
   SET "tierId" = t.id
  FROM "Business" b, "PricingTier" t
 WHERE s."businessId" = b.id
   AND b."vertical" = 'ECOMMERCE'
   AND t."slug" = 'ecom-free'
   AND s."tierId" = (SELECT id FROM "PricingTier" WHERE "slug" = 'free');
