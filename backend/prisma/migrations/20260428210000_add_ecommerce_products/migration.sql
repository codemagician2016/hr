-- E-commerce vertical Phase 1 — Product catalog (read-only storefront).
--
-- Adds Product + ProductCategory tables. Pure additive, no changes to
-- existing tables. Phase 2 (Cart + Order) lands separately when checkout
-- flow ships.

-- ProductCategory first since Product references it.
CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductCategory_businessId_slug_key"
  ON "ProductCategory"("businessId", "slug");

CREATE INDEX "ProductCategory_businessId_isPublished_sortOrder_idx"
  ON "ProductCategory"("businessId", "isPublished", "sortOrder");

ALTER TABLE "ProductCategory"
  ADD CONSTRAINT "ProductCategory_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Product table.
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "shortDescription" TEXT,
    "sku" TEXT,
    "priceMinor" INTEGER NOT NULL,
    "comparePriceMinor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "stockQty" INTEGER,
    "weightGrams" INTEGER,
    "weightDisplay" TEXT,
    "imageUrls" JSONB NOT NULL DEFAULT '[]',
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Product_businessId_slug_key"
  ON "Product"("businessId", "slug");

CREATE INDEX "Product_businessId_isPublished_sortOrder_idx"
  ON "Product"("businessId", "isPublished", "sortOrder");

CREATE INDEX "Product_categoryId_isPublished_sortOrder_idx"
  ON "Product"("categoryId", "isPublished", "sortOrder");

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
