-- Sprint 1.7 — Public API + webhooks (Business tier)

CREATE TABLE "ApiKey" (
  "id"         TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "keyHash"    TEXT NOT NULL,
  "keyLast4"   TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "scopes"     JSONB NOT NULL DEFAULT '{"read":[],"write":[]}',
  "lastUsedAt" TIMESTAMP(3),
  "isActive"   BOOLEAN NOT NULL DEFAULT true,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_businessId_isActive_idx" ON "ApiKey"("businessId", "isActive");
CREATE INDEX "ApiKey_keyHash_idx" ON "ApiKey"("keyHash");
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WebhookSubscription" (
  "id"         TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "url"        TEXT NOT NULL,
  "events"     JSONB NOT NULL DEFAULT '[]',
  "secret"     TEXT NOT NULL,
  "isActive"   BOOLEAN NOT NULL DEFAULT true,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WebhookSubscription_businessId_isActive_idx" ON "WebhookSubscription"("businessId", "isActive");
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WebhookDelivery" (
  "id"             TEXT NOT NULL,
  "businessId"     TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "event"          TEXT NOT NULL,
  "payload"        JSONB NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'PENDING',
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "responseStatus" INTEGER,
  "responseBody"   TEXT,
  "nextRetryAt"    TIMESTAMP(3),
  "deliveredAt"    TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WebhookDelivery_status_nextRetryAt_idx" ON "WebhookDelivery"("status", "nextRetryAt");
CREATE INDEX "WebhookDelivery_businessId_createdAt_idx" ON "WebhookDelivery"("businessId", "createdAt");
CREATE INDEX "WebhookDelivery_subscriptionId_idx" ON "WebhookDelivery"("subscriptionId");
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
