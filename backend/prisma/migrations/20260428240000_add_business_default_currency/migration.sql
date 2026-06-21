-- Add Business.defaultCurrency. Pre-fills the new-product form's
-- currency field. Null on existing rows; storefront falls back to "INR"
-- in the UI for back-compat. Per-product currencies are untouched.
ALTER TABLE "Business" ADD COLUMN "defaultCurrency" TEXT;
