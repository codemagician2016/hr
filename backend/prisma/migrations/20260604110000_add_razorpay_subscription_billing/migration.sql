-- Razorpay subscription billing (India/INR): id columns + webhook ledger.
-- Additive + idempotent — safe to (re)apply on a live DB.

ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "razorpayCustomerId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "razorpaySubscriptionId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_razorpaySubscriptionId_key" ON "Subscription"("razorpaySubscriptionId");

CREATE TABLE IF NOT EXISTS "RazorpayWebhookEvent" (
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
    CONSTRAINT "RazorpayWebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "RazorpayWebhookEvent_eventId_key" ON "RazorpayWebhookEvent"("eventId");
CREATE INDEX IF NOT EXISTS "RazorpayWebhookEvent_status_createdAt_idx" ON "RazorpayWebhookEvent"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "RazorpayWebhookEvent_eventType_createdAt_idx" ON "RazorpayWebhookEvent"("eventType", "createdAt");
CREATE INDEX IF NOT EXISTS "RazorpayWebhookEvent_businessId_createdAt_idx" ON "RazorpayWebhookEvent"("businessId", "createdAt");
