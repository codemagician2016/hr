-- Sprint 1.5 — Multi-location (Business tier). One new table.

CREATE TABLE "BusinessLocation" (
  "id"           TEXT NOT NULL,
  "businessId"   TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "addressLine1" TEXT,
  "addressLine2" TEXT,
  "city"         TEXT,
  "state"        TEXT,
  "postalCode"   TEXT,
  "country"      TEXT,
  "phone"        TEXT,
  "isPrimary"    BOOLEAN NOT NULL DEFAULT false,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessLocation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BusinessLocation_businessId_isActive_idx"
  ON "BusinessLocation"("businessId", "isActive");
ALTER TABLE "BusinessLocation"
  ADD CONSTRAINT "BusinessLocation_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
