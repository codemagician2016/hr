-- Branch-based pricing for the super-admin pricing studio.
-- Additive + non-breaking (nullable columns / defaulted column).

ALTER TABLE "PricingTier" ADD COLUMN "includedBranches" INTEGER;
ALTER TABLE "PricingTier" ADD COLUMN "contactSalesAboveBranches" INTEGER;
ALTER TABLE "TierPrice" ADD COLUMN "overageBranchPriceMinor" INTEGER NOT NULL DEFAULT 0;

-- Backfill: the Business-family tier in each vertical covers up to 3 branches at
-- its flat price; above 3 branches checkout routes to Contact Sales.
UPDATE "PricingTier"
  SET "includedBranches" = 3, "contactSalesAboveBranches" = 3
  WHERE "slug" IN ('business', 'ecom-business', 'static-business');
