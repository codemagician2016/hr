-- ProductBrandFamily + ProductBrand — two-level product-brand catalog.
-- The existing free-text Product.brand column stays as a snapshot of the
-- shelf-label name (so a rename doesn't rewrite order/cart history); the
-- new Product.brandId is the structured FK that drives analytics.

-- ── 1. ProductBrandFamily — the corporate parent (Unilever, ITC, etc.) ──
CREATE TABLE "ProductBrandFamily" (
  "id"          TEXT NOT NULL,
  "businessId"  TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "slug"        TEXT NOT NULL,
  "logoUrl"     TEXT,
  "description" TEXT,
  "countryCode" TEXT,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductBrandFamily_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ProductBrandFamily"
  ADD CONSTRAINT "ProductBrandFamily_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ProductBrandFamily_businessId_slug_key"
  ON "ProductBrandFamily"("businessId", "slug");

CREATE INDEX "ProductBrandFamily_businessId_isActive_sortOrder_idx"
  ON "ProductBrandFamily"("businessId", "isActive", "sortOrder");

-- ── 2. ProductBrand — the shelf-label brand (Surf, Dove, Pampers…) ─────
CREATE TABLE "ProductBrand" (
  "id"            TEXT NOT NULL,
  "businessId"    TEXT NOT NULL,
  "brandFamilyId" TEXT,
  "name"          TEXT NOT NULL,
  "slug"          TEXT NOT NULL,
  "logoUrl"       TEXT,
  "description"   TEXT,
  "countryCode"   TEXT,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"     INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductBrand_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ProductBrand"
  ADD CONSTRAINT "ProductBrand_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductBrand"
  ADD CONSTRAINT "ProductBrand_brandFamilyId_fkey"
  FOREIGN KEY ("brandFamilyId") REFERENCES "ProductBrandFamily"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ProductBrand_businessId_slug_key"
  ON "ProductBrand"("businessId", "slug");

CREATE INDEX "ProductBrand_businessId_brandFamilyId_idx"
  ON "ProductBrand"("businessId", "brandFamilyId");

CREATE INDEX "ProductBrand_businessId_isActive_sortOrder_idx"
  ON "ProductBrand"("businessId", "isActive", "sortOrder");

-- ── 3. Product.brandId — soft FK to ProductBrand ───────────────────────
ALTER TABLE "Product"
  ADD COLUMN "brandId" TEXT;

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_brandId_fkey"
  FOREIGN KEY ("brandId") REFERENCES "ProductBrand"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Product_brandId_idx" ON "Product"("brandId");
