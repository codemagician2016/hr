ALTER TABLE "SupportConversation"
  ADD COLUMN "projectKey" TEXT NOT NULL DEFAULT 'sitepresso',
  ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'CUSTOMER_SUPPORT',
  ADD COLUMN "sourceUrl" TEXT;

UPDATE "SupportConversation"
SET
  "projectKey" = CASE
    WHEN "kind" = 'PLATFORM_SUPPORT' THEN 'sitepresso'
    ELSE 'shop'
  END,
  "channel" = CASE
    WHEN "kind" = 'PLATFORM_SUPPORT' THEN 'TENANT_SUPPORT'
    ELSE 'CUSTOMER_SUPPORT'
  END;

CREATE INDEX "SupportConversation_projectKey_channel_lastMessageAt_idx"
  ON "SupportConversation"("projectKey", "channel", "lastMessageAt");
