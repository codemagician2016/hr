-- Drop Plan model. Subscription.planId -> tierId (FK to PricingTier).
-- Safe at this point because all subscriptions were wiped in the 2026-04-22
-- business reset (pre-wipe dump at /home/ubuntu/backups/pre-wipe-2026-04-22.sql).

ALTER TABLE "Subscription" DROP CONSTRAINT IF EXISTS "Subscription_planId_fkey";

ALTER TABLE "Subscription" RENAME COLUMN "planId" TO "tierId";

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_tierId_fkey"
  FOREIGN KEY ("tierId") REFERENCES "PricingTier"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TABLE "Plan";
