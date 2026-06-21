-- Correct the over-broad activatedAt grandfather from 20260613150000.
-- That backfill stamped activatedAt for ANY tenant with a gateway subscription
-- id — but Razorpay assigns the id at checkout-CREATION (before the mandate is
-- authorized), so a tenant who CANCELLED a checkout keeps a stale id on the
-- free placeholder tier and was wrongly grandfathered as "activated" (read as
-- expired instead of onboarding).
--
-- Keep activatedAt only where there's a genuine paid signal: a converted trial
-- or a past-due history. (Tenants still on a PAID tier don't rely on
-- activatedAt — the state machine reads the tier directly.)
UPDATE "Subscription" s
SET "activatedAt" = NULL
FROM "PricingTier" t
WHERE s."tierId" = t.id
  AND t.slug IN ('free', 'static-free', 'ecom-free', 'trial')
  AND s."trialConvertedAt" IS NULL
  AND s."pastDueSince" IS NULL;
