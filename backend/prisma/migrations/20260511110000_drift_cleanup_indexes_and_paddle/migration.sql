-- Drift cleanup (2026-05-11).
-- Captures pre-existing schema edits that never had a matching migration.
-- All items are intentional removals already reflected in schema.prisma.
--
--   1. PricingTier.paddlePrice{Monthly,Yearly}Id: legacy Paddle integration
--      columns superseded by ProviderPriceCache. Zero code references.
--   2. Index drops for Order.pickupLocationId, Product.brandId: the
--      schema-side @@index entries were intentionally removed; the DB
--      still carried the indexes from earlier migrations.

-- DropIndex
DROP INDEX IF EXISTS "Order_pickupLocationId_idx";

-- DropIndex
DROP INDEX IF EXISTS "PricingTier_paddlePriceMonthlyId_key";

-- DropIndex
DROP INDEX IF EXISTS "PricingTier_paddlePriceYearlyId_key";

-- DropIndex
DROP INDEX IF EXISTS "Product_brandId_idx";

-- AlterTable
ALTER TABLE "PricingTier"
  DROP COLUMN IF EXISTS "paddlePriceMonthlyId",
  DROP COLUMN IF EXISTS "paddlePriceYearlyId";
