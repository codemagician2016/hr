-- Sprint 2.7b — link Product → StoreBrand so a multi-store tenant can
-- scope products to a specific brand/store.
-- NULL = product is shared across all of the tenant's brands (the default).

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "storeBrandId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Product_storeBrandId_fkey'
  ) THEN
    ALTER TABLE "Product"
      ADD CONSTRAINT "Product_storeBrandId_fkey"
      FOREIGN KEY ("storeBrandId") REFERENCES "StoreBrand"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "Product_storeBrandId_idx" ON "Product"("storeBrandId");
