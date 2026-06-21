-- ECOMMERCE multi-store (2026-05-11) — location-scoping foundation.
--
-- Adds the data plumbing for a single tenant to operate N physical stores
-- (multi-city / multi-outlet). Customer-side resolution (pincode → store,
-- geo pin → store, manual outlet picker) and per-location pricing all
-- depend on these three additions:
--
--   1. Cart.locationId  → which store fulfils the shopper's basket.
--   2. Order.locationId → which store fulfilled the order (for reports + RBAC).
--   3. ProductLocationOverride → per-(product, location) price + availability.
--
-- All FKs ON DELETE SET NULL / CASCADE; columns nullable for back-compat
-- with single-location tenants. Drives Phase 1c (cart wiring) + Phase 2-6
-- of the multi-store rollout.

-- AlterTable
ALTER TABLE "Cart" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "locationId" TEXT;

-- CreateTable
CREATE TABLE "ProductLocationOverride" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "priceMinor" INTEGER,
    "comparePriceMinor" INTEGER,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductLocationOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductLocationOverride_businessId_locationId_isAvailable_idx" ON "ProductLocationOverride"("businessId", "locationId", "isAvailable");

-- CreateIndex
CREATE INDEX "ProductLocationOverride_locationId_isAvailable_idx" ON "ProductLocationOverride"("locationId", "isAvailable");

-- CreateIndex
CREATE UNIQUE INDEX "ProductLocationOverride_productId_locationId_key" ON "ProductLocationOverride"("productId", "locationId");

-- CreateIndex
CREATE INDEX "Cart_businessId_locationId_idx" ON "Cart"("businessId", "locationId");

-- CreateIndex
CREATE INDEX "Order_businessId_locationId_status_idx" ON "Order"("businessId", "locationId", "status");

-- AddForeignKey
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductLocationOverride" ADD CONSTRAINT "ProductLocationOverride_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductLocationOverride" ADD CONSTRAINT "ProductLocationOverride_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductLocationOverride" ADD CONSTRAINT "ProductLocationOverride_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

