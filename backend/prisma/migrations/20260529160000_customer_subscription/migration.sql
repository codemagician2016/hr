-- P6 — Customer-level Subscribe & Save (distinct from the platform
-- Subscription model used for SaaS billing). Order-generation cron consumes
-- nextDeliveryAt and stamps lastDeliveryAt as subsequent orders are placed.
CREATE TABLE "CustomerSubscription" (
  "id"             TEXT PRIMARY KEY,
  "businessId"     TEXT NOT NULL,
  "customerId"     TEXT NOT NULL,
  "productId"      TEXT NOT NULL,
  "variantId"      TEXT,
  "quantity"       INTEGER NOT NULL DEFAULT 1,
  "intervalKind"   TEXT NOT NULL DEFAULT 'WEEKLY',
  "intervalCount"  INTEGER NOT NULL DEFAULT 1,
  "discountPct"    INTEGER NOT NULL DEFAULT 5,
  "status"         TEXT NOT NULL DEFAULT 'ACTIVE',
  "nextDeliveryAt" TIMESTAMP(3),
  "lastDeliveryAt" TIMESTAMP(3),
  "pausedUntil"    TIMESTAMP(3),
  "cancelledAt"    TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL
);
CREATE INDEX "CustomerSubscription_businessId_customerId_idx" ON "CustomerSubscription"("businessId","customerId");
CREATE INDEX "CustomerSubscription_businessId_status_nextDeliveryAt_idx" ON "CustomerSubscription"("businessId","status","nextDeliveryAt");
