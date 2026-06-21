-- Phase 1+2 (payment-mode admin toggle) + Phase 3 (Click & Collect) — single
-- migration so the new Order columns and the new pickup model land
-- together. Existing tenants stay backward compatible: paymentMode='BOTH'
-- + pickupEnabled=false + fulfillmentType='DELIVERY' default to current
-- behaviour.

-- ── 1. Business: payment-mode policy + Click & Collect toggle ──────────
ALTER TABLE "Business"
  ADD COLUMN "paymentMode"   TEXT NOT NULL DEFAULT 'BOTH',
  ADD COLUMN "pickupEnabled" BOOLEAN NOT NULL DEFAULT false;

-- ── 2. Order: payment method + fulfillment branch + pickup snapshot ────
ALTER TABLE "Order"
  ADD COLUMN "paymentMethod"    TEXT,
  ADD COLUMN "fulfillmentType"  TEXT NOT NULL DEFAULT 'DELIVERY',
  ADD COLUMN "pickupLocationId" TEXT,
  ADD COLUMN "pickupCode"       TEXT,
  ADD COLUMN "pickupReadyAt"    TIMESTAMP(3),
  ADD COLUMN "pickedUpAt"       TIMESTAMP(3);

CREATE INDEX "Order_pickupLocationId_idx" ON "Order"("pickupLocationId");

-- ── 3. OrderStatus enum: add READY_FOR_PICKUP + PICKED_UP ──────────────
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'READY_FOR_PICKUP';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PICKED_UP';

-- ── 4. EcomPickupLocation — store / counter records ────────────────────
CREATE TABLE "EcomPickupLocation" (
  "id"                 TEXT NOT NULL,
  "businessId"         TEXT NOT NULL,
  "name"               TEXT NOT NULL,
  "addressLine1"       TEXT NOT NULL,
  "addressLine2"       TEXT,
  "city"               TEXT NOT NULL,
  "region"             TEXT,
  "postalCode"         TEXT NOT NULL,
  "countryCode"        TEXT NOT NULL,
  "latitude"           DOUBLE PRECISION,
  "longitude"          DOUBLE PRECISION,
  "contactPhone"       TEXT,
  "contactEmail"       TEXT,
  "hours"              JSONB NOT NULL DEFAULT '{}',
  "prepTimeMinutes"    INTEGER NOT NULL DEFAULT 30,
  "pickupInstructions" TEXT,
  "isActive"           BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"          INTEGER NOT NULL DEFAULT 0,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomPickupLocation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EcomPickupLocation"
  ADD CONSTRAINT "EcomPickupLocation_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_pickupLocationId_fkey"
  FOREIGN KEY ("pickupLocationId") REFERENCES "EcomPickupLocation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "EcomPickupLocation_businessId_isActive_sortOrder_idx"
  ON "EcomPickupLocation"("businessId", "isActive", "sortOrder");
