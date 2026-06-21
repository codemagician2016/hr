-- Link Click & Collect pickup counters to ecommerce physical store locations.
-- NULL remains valid for legacy/global pickup counters shared by all stores.

ALTER TABLE "EcomPickupLocation"
  ADD COLUMN IF NOT EXISTS "locationId" TEXT;

CREATE INDEX IF NOT EXISTS "EcomPickupLocation_businessId_locationId_isActive_idx"
  ON "EcomPickupLocation"("businessId", "locationId", "isActive");

ALTER TABLE "EcomPickupLocation"
  ADD CONSTRAINT "EcomPickupLocation_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
