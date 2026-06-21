ALTER TABLE "Subscription"
  ADD COLUMN IF NOT EXISTS "paddleTransactionId" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingTierSlug" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingBillingCycle" "BillingCycle",
  ADD COLUMN IF NOT EXISTS "pendingChangeEffectiveAt" TIMESTAMP(3);
