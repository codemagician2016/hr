-- Sprint 2.6 — Multi-currency support on storefront (ECOMMERCE Pro tier)
ALTER TABLE "Business"
  ADD COLUMN "supportedCurrencies" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
