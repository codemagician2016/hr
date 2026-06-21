-- Product.specs — structured spec sheet for electronics-style themes.
-- JSON shape: { highlights: string[], groups: [{ title, rows: [{ label, value }] }] }.
-- Nullable + additive; non-spec verticals leave it null.
ALTER TABLE "Product" ADD COLUMN "specs" JSONB;
