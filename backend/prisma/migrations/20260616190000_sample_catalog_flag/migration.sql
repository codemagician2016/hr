-- "Load sample catalog" tags everything it seeds with isSample = true so a single
-- "Remove samples" click can delete exactly what was seeded, leaving the merchant's
-- own products/categories/brands untouched. Additive + nullable-safe (defaults false).
ALTER TABLE "Product"            ADD COLUMN "isSample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProductCategory"    ADD COLUMN "isSample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProductBrand"       ADD COLUMN "isSample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProductBrandFamily" ADD COLUMN "isSample" BOOLEAN NOT NULL DEFAULT false;
