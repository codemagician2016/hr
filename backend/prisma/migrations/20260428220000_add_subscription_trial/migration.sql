-- 14-day free trial state machine on Subscription.
--
-- Every paid plan can start with a trial. trialEndsAt drives the
-- daily cron that expires trials and downgrades users to Free if no
-- payment was added. trialConvertedAt locks once they pay so we don't
-- let them re-trial.
--
-- Backward compatible: existing tenants have these fields NULL — they're
-- not in trial (already on a real tier or Free), behaviour unchanged.

ALTER TABLE "Subscription" ADD COLUMN "trialPlanSlug" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "trialStartedAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "trialConvertedAt" TIMESTAMP(3);

-- Daily cron query "expired trials to downgrade" hits this index.
CREATE INDEX "Subscription_trialEndsAt_trialConvertedAt_idx"
  ON "Subscription"("trialEndsAt", "trialConvertedAt")
  WHERE "trialEndsAt" IS NOT NULL AND "trialConvertedAt" IS NULL;
