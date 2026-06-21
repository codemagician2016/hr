-- Storefront (public) business address — structured fields to mirror the billing
-- profile, so the Settings business address can use the same country-aware widget
-- as onboarding/billing (address line 2, city, postal code). Additive + nullable,
-- so it applies cleanly with no backfill. The existing single-line `address` stays
-- as line 1; `state`/`country` already exist.
ALTER TABLE "Business"
  ADD COLUMN "addressLine2" TEXT,
  ADD COLUMN "city"         TEXT,
  ADD COLUMN "postalCode"   TEXT;
