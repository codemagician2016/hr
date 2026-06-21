-- Sprint 1.1 — Multi-channel notifications schema (SMS + WhatsApp + Email
-- + dynamic per-country budget engine). All tables additive; existing rows
-- unaffected. Default messaging budget is 0% so existing tiers remain
-- email-only until super-admin sets messagingBudgetPercent on each.

-- 1) PricingTier — per-tier budget allocation (% of plan price spent on SMS+WA)
ALTER TABLE "PricingTier"
  ADD COLUMN "messagingBudgetPercent" DECIMAL(5, 2) NOT NULL DEFAULT 0;

-- 2) ProviderPriceCache — daily-refreshed Twilio Pricing API + MSG91 manual
CREATE TABLE "ProviderPriceCache" (
  "id"              TEXT NOT NULL,
  "countryCode"     TEXT NOT NULL,
  "channel"         TEXT NOT NULL,
  "providerCostUsd" DECIMAL(10, 6) NOT NULL,
  "source"          TEXT NOT NULL,
  "isAvailable"     BOOLEAN NOT NULL DEFAULT true,
  "lastRefreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderPriceCache_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProviderPriceCache_countryCode_channel_key"
  ON "ProviderPriceCache"("countryCode", "channel");
CREATE INDEX "ProviderPriceCache_countryCode_idx"
  ON "ProviderPriceCache"("countryCode");
CREATE INDEX "ProviderPriceCache_channel_isAvailable_idx"
  ON "ProviderPriceCache"("channel", "isAvailable");

-- 3) NotificationConfig — per-business gates + customer-side preferences
CREATE TABLE "NotificationConfig" (
  "id"                       TEXT NOT NULL,
  "businessId"               TEXT NOT NULL,
  "managedSmsEnabled"        BOOLEAN NOT NULL DEFAULT false,
  "managedWhatsappEnabled"   BOOLEAN NOT NULL DEFAULT false,
  "budgetOverridePercent"    DECIMAL(5, 2),
  "requestAccessStatus"      TEXT NOT NULL DEFAULT 'NONE',
  "requestAccessNote"        TEXT,
  "requestAccessAt"          TIMESTAMP(3),
  "requestReviewedAt"        TIMESTAMP(3),
  "requestReviewedBy"        TEXT,
  "eventChannels"            JSONB NOT NULL DEFAULT '{}',
  "quotaExhaustedAction"     TEXT NOT NULL DEFAULT 'PAUSE',
  "quotaExhaustedNotified"   BOOLEAN NOT NULL DEFAULT false,
  "smsTermsAcceptedAt"       TIMESTAMP(3),
  "smsTermsVersion"          TEXT,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationConfig_businessId_key"
  ON "NotificationConfig"("businessId");
CREATE INDEX "NotificationConfig_requestAccessStatus_idx"
  ON "NotificationConfig"("requestAccessStatus");
ALTER TABLE "NotificationConfig"
  ADD CONSTRAINT "NotificationConfig_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4) MessageTemplate — pre-approved DLT/Twilio template registry
CREATE TABLE "MessageTemplate" (
  "id"               TEXT NOT NULL,
  "templateKey"      TEXT NOT NULL,
  "displayName"      TEXT NOT NULL,
  "category"         TEXT NOT NULL,
  "vertical"         TEXT NOT NULL DEFAULT 'ALL',
  "body"             TEXT NOT NULL,
  "variables"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "msg91TemplateId"  TEXT,
  "twilioContentSid" TEXT,
  "approvalStatus"   TEXT NOT NULL DEFAULT 'DRAFT',
  "approvalNote"     TEXT,
  "approvedAt"       TIMESTAMP(3),
  "smsEnabled"       BOOLEAN NOT NULL DEFAULT true,
  "whatsappEnabled"  BOOLEAN NOT NULL DEFAULT false,
  "emailEnabled"     BOOLEAN NOT NULL DEFAULT true,
  "isActive"         BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"        INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MessageTemplate_templateKey_key"
  ON "MessageTemplate"("templateKey");
CREATE INDEX "MessageTemplate_vertical_isActive_sortOrder_idx"
  ON "MessageTemplate"("vertical", "isActive", "sortOrder");

-- 5) MessageDelivery — immutable audit log of every send attempt
CREATE TABLE "MessageDelivery" (
  "id"                 TEXT NOT NULL,
  "businessId"         TEXT NOT NULL,
  "recipientPhone"     TEXT,
  "recipientEmail"     TEXT,
  "recipientCountry"   TEXT NOT NULL,
  "channel"            TEXT NOT NULL,
  "templateId"         TEXT,
  "bodySnapshot"       TEXT NOT NULL,
  "variables"          JSONB,
  "providerCostUsd"    DECIMAL(10, 6) NOT NULL DEFAULT 0,
  "provider"           TEXT NOT NULL,
  "providerMessageId"  TEXT,
  "status"             TEXT NOT NULL DEFAULT 'PENDING',
  "failureReason"      TEXT,
  "triggeredBy"        TEXT NOT NULL,
  "appointmentId"      TEXT,
  "orderId"            TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt"             TIMESTAMP(3),
  "deliveredAt"        TIMESTAMP(3),
  CONSTRAINT "MessageDelivery_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MessageDelivery_businessId_createdAt_idx"
  ON "MessageDelivery"("businessId", "createdAt");
CREATE INDEX "MessageDelivery_recipientPhone_channel_idx"
  ON "MessageDelivery"("recipientPhone", "channel");
CREATE INDEX "MessageDelivery_status_idx"
  ON "MessageDelivery"("status");
CREATE INDEX "MessageDelivery_triggeredBy_idx"
  ON "MessageDelivery"("triggeredBy");
ALTER TABLE "MessageDelivery"
  ADD CONSTRAINT "MessageDelivery_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageDelivery"
  ADD CONSTRAINT "MessageDelivery_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 6) BudgetUsage — per-business per-cycle spend tracking
CREATE TABLE "BudgetUsage" (
  "id"                  TEXT NOT NULL,
  "businessId"          TEXT NOT NULL,
  "cycle"               TEXT NOT NULL,
  "smsSpentUsd"         DECIMAL(10, 6) NOT NULL DEFAULT 0,
  "whatsappSpentUsd"    DECIMAL(10, 6) NOT NULL DEFAULT 0,
  "smsCount"            INTEGER NOT NULL DEFAULT 0,
  "whatsappCount"       INTEGER NOT NULL DEFAULT 0,
  "overagePurchasedUsd" DECIMAL(10, 2) NOT NULL DEFAULT 0,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BudgetUsage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BudgetUsage_businessId_cycle_key"
  ON "BudgetUsage"("businessId", "cycle");
CREATE INDEX "BudgetUsage_cycle_idx"
  ON "BudgetUsage"("cycle");
ALTER TABLE "BudgetUsage"
  ADD CONSTRAINT "BudgetUsage_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 7) SmsOptOut — universal opt-out list (TCPA/TRAI compliance)
CREATE TABLE "SmsOptOut" (
  "id"                    TEXT NOT NULL,
  "recipientPhone"        TEXT NOT NULL,
  "source"                TEXT NOT NULL,
  "optedOutAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "triggeredByBusinessId" TEXT,
  CONSTRAINT "SmsOptOut_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SmsOptOut_recipientPhone_key"
  ON "SmsOptOut"("recipientPhone");
CREATE INDEX "SmsOptOut_recipientPhone_idx"
  ON "SmsOptOut"("recipientPhone");
