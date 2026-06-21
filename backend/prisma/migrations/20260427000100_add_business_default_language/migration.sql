-- Add Business.defaultLanguage so tenant admins can set their "house language".
-- Falls back to the existing customer/cookie/geo chain when NULL — opt-in only,
-- no behaviour change for existing tenants.

ALTER TABLE "Business" ADD COLUMN "defaultLanguage" TEXT;
