-- Multi-gateway billing: Stripe (NZ/NZD) + Razorpay (IN/INR) alongside Paddle (RoW).
-- Fully additive + idempotent (IF NOT EXISTS) so it is safe to (re)apply on a live DB.

-- Subscription: active gateway discriminator + Stripe identifiers
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "gateway" TEXT NOT NULL DEFAULT 'PADDLE';
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");

-- TierPrice: per-gateway price/plan refs (null where that gateway doesn't sell the tier)
ALTER TABLE "TierPrice" ADD COLUMN IF NOT EXISTS "stripePriceIdMonthly" TEXT;
ALTER TABLE "TierPrice" ADD COLUMN IF NOT EXISTS "stripePriceIdAnnual" TEXT;
ALTER TABLE "TierPrice" ADD COLUMN IF NOT EXISTS "razorpayPlanIdMonthly" TEXT;
ALTER TABLE "TierPrice" ADD COLUMN IF NOT EXISTS "razorpayPlanIdAnnual" TEXT;

-- Stripe webhook ledger (mirrors PaddleWebhookEvent)
CREATE TABLE IF NOT EXISTS "StripeWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "businessId" TEXT,
    "objectId" TEXT,
    "occurredAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StripeWebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StripeWebhookEvent_eventId_key" ON "StripeWebhookEvent"("eventId");
CREATE INDEX IF NOT EXISTS "StripeWebhookEvent_status_createdAt_idx" ON "StripeWebhookEvent"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "StripeWebhookEvent_eventType_createdAt_idx" ON "StripeWebhookEvent"("eventType", "createdAt");
CREATE INDEX IF NOT EXISTS "StripeWebhookEvent_businessId_createdAt_idx" ON "StripeWebhookEvent"("businessId", "createdAt");
