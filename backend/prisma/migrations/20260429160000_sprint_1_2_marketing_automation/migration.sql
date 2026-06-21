-- Sprint 1.2 — Marketing automation (Pro tier).
-- Three new tables. Additive; existing rows unaffected.

-- 1) AutomationCampaign — per-tenant per-campaign config
CREATE TABLE "AutomationCampaign" (
  "id"                 TEXT NOT NULL,
  "businessId"         TEXT NOT NULL,
  "campaignKey"        TEXT NOT NULL,
  "isEnabled"          BOOLEAN NOT NULL DEFAULT false,
  "channels"           JSONB NOT NULL DEFAULT '{"email":true,"sms":false,"whatsapp":false}',
  "customSubject"      TEXT,
  "customBody"         TEXT,
  "customCouponCode"   TEXT,
  "delayHoursOverride" INTEGER,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomationCampaign_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AutomationCampaign_businessId_campaignKey_key"
  ON "AutomationCampaign"("businessId", "campaignKey");
CREATE INDEX "AutomationCampaign_businessId_isEnabled_idx"
  ON "AutomationCampaign"("businessId", "isEnabled");
ALTER TABLE "AutomationCampaign"
  ADD CONSTRAINT "AutomationCampaign_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2) AutomationEnrollment — one row per (campaign × recipient × trigger event)
CREATE TABLE "AutomationEnrollment" (
  "id"                TEXT NOT NULL,
  "businessId"        TEXT NOT NULL,
  "campaignId"        TEXT NOT NULL,
  "customerId"        TEXT,
  "recipientEmail"    TEXT,
  "recipientPhone"    TEXT,
  "recipientName"     TEXT,
  "triggeredAt"       TIMESTAMP(3) NOT NULL,
  "scheduledFor"      TIMESTAMP(3) NOT NULL,
  "sentAt"            TIMESTAMP(3),
  "status"            TEXT NOT NULL DEFAULT 'PENDING',
  "failureReason"     TEXT,
  "variables"         JSONB,
  "messageDeliveryId" TEXT,
  "openedAt"          TIMESTAMP(3),
  "clickedAt"         TIMESTAMP(3),
  "unsubscribedAt"    TIMESTAMP(3),
  "triggerSourceId"   TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomationEnrollment_pkey" PRIMARY KEY ("id")
);
-- Compound uniqueness prevents accidental dual-enrollment per source event.
CREATE UNIQUE INDEX "AutomationEnrollment_unique_per_trigger"
  ON "AutomationEnrollment"("businessId", "campaignId", "customerId", "triggeredAt", "triggerSourceId");
CREATE INDEX "AutomationEnrollment_businessId_campaignId_status_idx"
  ON "AutomationEnrollment"("businessId", "campaignId", "status");
CREATE INDEX "AutomationEnrollment_scheduledFor_status_idx"
  ON "AutomationEnrollment"("scheduledFor", "status");
CREATE INDEX "AutomationEnrollment_customerId_idx"
  ON "AutomationEnrollment"("customerId");
ALTER TABLE "AutomationEnrollment"
  ADD CONSTRAINT "AutomationEnrollment_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationEnrollment"
  ADD CONSTRAINT "AutomationEnrollment_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "AutomationCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationEnrollment"
  ADD CONSTRAINT "AutomationEnrollment_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3) CustomerMarketingOptOut — granular per-tenant unsubscribe
CREATE TABLE "CustomerMarketingOptOut" (
  "id"             TEXT NOT NULL,
  "businessId"     TEXT NOT NULL,
  "customerId"     TEXT,
  "recipientEmail" TEXT,
  "source"         TEXT NOT NULL,
  "campaignKey"    TEXT,
  "optedOutAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerMarketingOptOut_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerMarketingOptOut_businessId_customerId_campaignKey_key"
  ON "CustomerMarketingOptOut"("businessId", "customerId", "campaignKey");
CREATE UNIQUE INDEX "CustomerMarketingOptOut_businessId_recipientEmail_campaignKey_key"
  ON "CustomerMarketingOptOut"("businessId", "recipientEmail", "campaignKey");
CREATE INDEX "CustomerMarketingOptOut_businessId_customerId_idx"
  ON "CustomerMarketingOptOut"("businessId", "customerId");
CREATE INDEX "CustomerMarketingOptOut_businessId_recipientEmail_idx"
  ON "CustomerMarketingOptOut"("businessId", "recipientEmail");
ALTER TABLE "CustomerMarketingOptOut"
  ADD CONSTRAINT "CustomerMarketingOptOut_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerMarketingOptOut"
  ADD CONSTRAINT "CustomerMarketingOptOut_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
