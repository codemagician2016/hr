ALTER TABLE "InventoryStock"
  ADD COLUMN "supplierSku" TEXT,
  ADD COLUMN "localPickCode" TEXT,
  ADD COLUMN "aisleCode" TEXT,
  ADD COLUMN "rackCode" TEXT,
  ADD COLUMN "shelfCode" TEXT;

CREATE INDEX "InventoryStock_businessId_supplierSku_idx" ON "InventoryStock"("businessId", "supplierSku");
CREATE INDEX "InventoryStock_businessId_localPickCode_idx" ON "InventoryStock"("businessId", "localPickCode");
CREATE INDEX "ProductBrandFamily_businessId_countryCode_idx" ON "ProductBrandFamily"("businessId", "countryCode");
CREATE INDEX "ProductBrand_businessId_countryCode_idx" ON "ProductBrand"("businessId", "countryCode");
