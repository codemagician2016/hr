-- Per-staff "Show on website" flag so business owners can curate who
-- appears on the public team section (independent of operational status).
-- Defaults to true so existing staff keep their current visibility.
-- AlterTable
ALTER TABLE "User"
  ADD COLUMN "showOnWebsite" BOOLEAN NOT NULL DEFAULT true;
