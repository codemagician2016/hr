-- Sprint 2.6b — Per-currency product price overrides.
--
-- Phase 2.6 added Business.supportedCurrencies[] + defaultCurrency. Today
-- products are priced in the defaultCurrency only; storefronts targeting
-- another supported currency render via FX conversion at request time.
-- This migration adds explicit per-currency overrides so a tenant can
-- price a product manually per market (e.g. ₹999 in INR but $14.99 USD,
-- not the FX-derived $11.78).
--
-- NULL fields = fall back to the FX-converted defaultCurrency price.

CREATE TABLE IF NOT EXISTS "ProductPrice" (
  "id"                TEXT NOT NULL,
  "productId"         TEXT NOT NULL,
  "currencyCode"      TEXT NOT NULL,    -- ISO 4217 (INR, USD, GBP, …)
  "priceMinor"        INTEGER NOT NULL, -- per-currency override
  "comparePriceMinor" INTEGER,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProductPrice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductPrice_productId_currencyCode_key"
  ON "ProductPrice"("productId", "currencyCode");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'ProductPrice_productId_fkey'
  ) THEN
    ALTER TABLE "ProductPrice"
      ADD CONSTRAINT "ProductPrice_productId_fkey"
      FOREIGN KEY ("productId") REFERENCES "Product"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;
