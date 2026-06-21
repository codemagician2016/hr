-- ProductVariant — apparel/fashion option axes (Size × Color matrix).
-- Additive + nullable: existing single-axis grocery variants (which use
-- `label` alone) are untouched. When set, the storefront renders size pills
-- + colour swatches and resolves the (option1,option2) pair back to the
-- exact variant for its own price/stock. `label` stays the composed display.
ALTER TABLE "ProductVariant"
  ADD COLUMN "option1Name"  TEXT,
  ADD COLUMN "option1Value" TEXT,
  ADD COLUMN "option2Name"  TEXT,
  ADD COLUMN "option2Value" TEXT,
  ADD COLUMN "swatchHex"    TEXT,
  ADD COLUMN "imageUrl"     TEXT;
