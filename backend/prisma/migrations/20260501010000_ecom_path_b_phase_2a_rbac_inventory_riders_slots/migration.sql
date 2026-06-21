-- ECOMMERCE Path B Phase 2a (2026-05-01) — purely additive migration.
--
-- Adds the relational entities for the full grocery-operations console:
--   * RBAC: EcomPermission (catalog) + EcomRolePermissionGrant (M2M)
--   * Inventory: per-(Product,Location) stock + audit ledger
--   * Riders: fleet roster with vehicle/license/zone metadata
--   * Routes: batched delivery runs with stops + COD reconciliation
--   * Slots: time-window delivery slots with capacity caps + bookings
--
-- All new tables/enums; no existing column or constraint modifications.
-- STATIC + APPOINTMENT verticals are unaffected — these tables sit
-- empty for them. Existing BusinessRole.permissions JSON column is
-- preserved as legacy back-compat for APPOINTMENT-vertical roles.
--
-- No backfill needed. Migration is safe to roll back by dropping the
-- new tables (no FK cycles into pre-existing tables that would block
-- DROP).

-- ─── Enums ────────────────────────────────────────────────────────────────

CREATE TYPE "InventoryAdjustmentReason" AS ENUM (
  'GRN_RECEIPT',
  'ORDER_PICK',
  'ORDER_FULFILL',
  'ORDER_CANCEL',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'RETURN_RESTOCK',
  'RETURN_SCRAP',
  'DAMAGE',
  'THEFT',
  'EXPIRY',
  'COUNT_ADJUSTMENT',
  'PROMOTIONAL_GIVEAWAY',
  'OTHER'
);

CREATE TYPE "RiderStatus" AS ENUM (
  'ACTIVE',
  'OFF_SHIFT',
  'ON_LEAVE',
  'SUSPENDED',
  'DEPARTED'
);

CREATE TYPE "DeliveryRouteStatus" AS ENUM (
  'PENDING',
  'DISPATCHED',
  'COMPLETED',
  'CANCELLED'
);

CREATE TYPE "DeliveryStopStatus" AS ENUM (
  'PENDING',
  'EN_ROUTE',
  'ARRIVED',
  'DELIVERED',
  'ATTEMPTED_FAILED',
  'SKIPPED'
);

CREATE TYPE "DeliverySlotType" AS ENUM (
  'STANDARD',
  'EXPRESS',
  'SAME_DAY',
  'NEXT_DAY',
  'SCHEDULED'
);

CREATE TYPE "SlotBookingStatus" AS ENUM (
  'HELD',
  'CONFIRMED',
  'RELEASED'
);

-- ─── EcomPermission (global catalog) ──────────────────────────────────────

CREATE TABLE "EcomPermission" (
  "id"          TEXT NOT NULL,
  "key"         TEXT NOT NULL,
  "area"        TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "description" TEXT,
  "weight"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomPermission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EcomPermission_key_key" ON "EcomPermission"("key");
CREATE INDEX "EcomPermission_area_weight_idx" ON "EcomPermission"("area", "weight");

-- ─── EcomRolePermissionGrant (M2M with optional location scope) ───────────

CREATE TABLE "EcomRolePermissionGrant" (
  "id"           TEXT NOT NULL,
  "businessId"   TEXT NOT NULL,
  "roleId"       TEXT NOT NULL,
  "permissionId" TEXT NOT NULL,
  "locationId"   TEXT,
  "grantedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"    TIMESTAMP(3),
  CONSTRAINT "EcomRolePermissionGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EcomRolePermissionGrant_roleId_permissionId_locationId_key"
  ON "EcomRolePermissionGrant"("roleId", "permissionId", "locationId");
CREATE INDEX "EcomRolePermissionGrant_businessId_idx"
  ON "EcomRolePermissionGrant"("businessId");
CREATE INDEX "EcomRolePermissionGrant_locationId_idx"
  ON "EcomRolePermissionGrant"("locationId");

ALTER TABLE "EcomRolePermissionGrant"
  ADD CONSTRAINT "EcomRolePermissionGrant_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomRolePermissionGrant"
  ADD CONSTRAINT "EcomRolePermissionGrant_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "BusinessRole"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomRolePermissionGrant"
  ADD CONSTRAINT "EcomRolePermissionGrant_permissionId_fkey"
    FOREIGN KEY ("permissionId") REFERENCES "EcomPermission"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomRolePermissionGrant"
  ADD CONSTRAINT "EcomRolePermissionGrant_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── InventoryStock (per Product × Location) ──────────────────────────────

CREATE TABLE "InventoryStock" (
  "id"            TEXT NOT NULL,
  "businessId"    TEXT NOT NULL,
  "productId"     TEXT NOT NULL,
  "locationId"    TEXT NOT NULL,
  "onHand"        INTEGER NOT NULL DEFAULT 0,
  "reserved"      INTEGER NOT NULL DEFAULT 0,
  "reorderPoint"  INTEGER NOT NULL DEFAULT 0,
  "reorderQty"    INTEGER NOT NULL DEFAULT 0,
  "unitCostMinor" INTEGER,
  "binLocation"   TEXT,
  "expiresAt"     TIMESTAMP(3),
  "lastCountedAt" TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryStock_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventoryStock_productId_locationId_key"
  ON "InventoryStock"("productId", "locationId");
CREATE INDEX "InventoryStock_businessId_locationId_idx"
  ON "InventoryStock"("businessId", "locationId");
CREATE INDEX "InventoryStock_businessId_onHand_idx"
  ON "InventoryStock"("businessId", "onHand");

ALTER TABLE "InventoryStock"
  ADD CONSTRAINT "InventoryStock_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InventoryStock"
  ADD CONSTRAINT "InventoryStock_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InventoryStock"
  ADD CONSTRAINT "InventoryStock_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── InventoryAdjustment (audit ledger) ───────────────────────────────────

CREATE TABLE "InventoryAdjustment" (
  "id"          TEXT NOT NULL,
  "businessId"  TEXT NOT NULL,
  "stockId"     TEXT NOT NULL,
  "delta"       INTEGER NOT NULL,
  "reason"      "InventoryAdjustmentReason" NOT NULL,
  "note"        TEXT,
  "sourceType"  TEXT,
  "sourceId"    TEXT,
  "onHandAfter" INTEGER NOT NULL,
  "actorUserId" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InventoryAdjustment_businessId_createdAt_idx"
  ON "InventoryAdjustment"("businessId", "createdAt");
CREATE INDEX "InventoryAdjustment_stockId_createdAt_idx"
  ON "InventoryAdjustment"("stockId", "createdAt");
CREATE INDEX "InventoryAdjustment_sourceType_sourceId_idx"
  ON "InventoryAdjustment"("sourceType", "sourceId");

ALTER TABLE "InventoryAdjustment"
  ADD CONSTRAINT "InventoryAdjustment_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InventoryAdjustment"
  ADD CONSTRAINT "InventoryAdjustment_stockId_fkey"
    FOREIGN KEY ("stockId") REFERENCES "InventoryStock"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── EcomRider (delivery fleet) ───────────────────────────────────────────

CREATE TABLE "EcomRider" (
  "id"                TEXT NOT NULL,
  "businessId"        TEXT NOT NULL,
  "userId"            TEXT,
  "fullName"          TEXT NOT NULL,
  "phone"             TEXT NOT NULL,
  "email"             TEXT,
  "vehicleType"       TEXT NOT NULL,
  "vehicleReg"        TEXT,
  "licenseNo"         TEXT,
  "licenseExpiresAt"  TIMESTAMP(3),
  "insuranceExpiresAt" TIMESTAMP(3),
  "homeLocationId"    TEXT,
  "serviceZones"      JSONB NOT NULL DEFAULT '[]',
  "status"            "RiderStatus" NOT NULL DEFAULT 'ACTIVE',
  "cashFloatMinor"    INTEGER NOT NULL DEFAULT 0,
  "totalDeliveries"   INTEGER NOT NULL DEFAULT 0,
  "onTimeRate"        DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "avgRating"         DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomRider_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EcomRider_businessId_status_idx" ON "EcomRider"("businessId", "status");
CREATE INDEX "EcomRider_homeLocationId_idx" ON "EcomRider"("homeLocationId");

ALTER TABLE "EcomRider"
  ADD CONSTRAINT "EcomRider_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomRider"
  ADD CONSTRAINT "EcomRider_homeLocationId_fkey"
    FOREIGN KEY ("homeLocationId") REFERENCES "BusinessLocation"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── EcomDeliveryRoute (batched run) ──────────────────────────────────────

CREATE TABLE "EcomDeliveryRoute" (
  "id"                  TEXT NOT NULL,
  "businessId"          TEXT NOT NULL,
  "locationId"          TEXT NOT NULL,
  "riderId"             TEXT,
  "code"                TEXT NOT NULL,
  "status"              "DeliveryRouteStatus" NOT NULL DEFAULT 'PENDING',
  "scheduledAt"         TIMESTAMP(3),
  "dispatchedAt"        TIMESTAMP(3),
  "completedAt"         TIMESTAMP(3),
  "totalStops"          INTEGER NOT NULL DEFAULT 0,
  "totalDistanceMeters" INTEGER,
  "plannedDurationMin"  INTEGER,
  "cashToCollectMinor"  INTEGER NOT NULL DEFAULT 0,
  "cashCollectedMinor"  INTEGER NOT NULL DEFAULT 0,
  "notes"               TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomDeliveryRoute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EcomDeliveryRoute_code_key" ON "EcomDeliveryRoute"("code");
CREATE INDEX "EcomDeliveryRoute_businessId_status_scheduledAt_idx"
  ON "EcomDeliveryRoute"("businessId", "status", "scheduledAt");
CREATE INDEX "EcomDeliveryRoute_locationId_scheduledAt_idx"
  ON "EcomDeliveryRoute"("locationId", "scheduledAt");
CREATE INDEX "EcomDeliveryRoute_riderId_scheduledAt_idx"
  ON "EcomDeliveryRoute"("riderId", "scheduledAt");

ALTER TABLE "EcomDeliveryRoute"
  ADD CONSTRAINT "EcomDeliveryRoute_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomDeliveryRoute"
  ADD CONSTRAINT "EcomDeliveryRoute_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomDeliveryRoute"
  ADD CONSTRAINT "EcomDeliveryRoute_riderId_fkey"
    FOREIGN KEY ("riderId") REFERENCES "EcomRider"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── EcomDeliveryRouteStop ────────────────────────────────────────────────

CREATE TABLE "EcomDeliveryRouteStop" (
  "id"                 TEXT NOT NULL,
  "routeId"            TEXT NOT NULL,
  "orderId"            TEXT,
  "sequence"           INTEGER NOT NULL,
  "addressLine1"       TEXT,
  "addressLine2"       TEXT,
  "city"               TEXT,
  "postalCode"         TEXT,
  "lat"                DOUBLE PRECISION,
  "lng"                DOUBLE PRECISION,
  "status"             "DeliveryStopStatus" NOT NULL DEFAULT 'PENDING',
  "arrivedAt"          TIMESTAMP(3),
  "deliveredAt"        TIMESTAMP(3),
  "proofPhotoUrl"      TEXT,
  "proofSignatureUrl"  TEXT,
  "customerRating"     INTEGER,
  "customerFeedback"   TEXT,
  "cashCollectedMinor" INTEGER NOT NULL DEFAULT 0,
  "notes"              TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomDeliveryRouteStop_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EcomDeliveryRouteStop_routeId_sequence_key"
  ON "EcomDeliveryRouteStop"("routeId", "sequence");
CREATE INDEX "EcomDeliveryRouteStop_orderId_idx"
  ON "EcomDeliveryRouteStop"("orderId");

ALTER TABLE "EcomDeliveryRouteStop"
  ADD CONSTRAINT "EcomDeliveryRouteStop_routeId_fkey"
    FOREIGN KEY ("routeId") REFERENCES "EcomDeliveryRoute"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── EcomDeliverySlot ─────────────────────────────────────────────────────

CREATE TABLE "EcomDeliverySlot" (
  "id"                         TEXT NOT NULL,
  "businessId"                 TEXT NOT NULL,
  "locationId"                 TEXT NOT NULL,
  "dayOfWeek"                  INTEGER,
  "specificDate"               TIMESTAMP(3),
  "startTime"                  TEXT NOT NULL,
  "endTime"                    TEXT NOT NULL,
  "capacity"                   INTEGER NOT NULL DEFAULT 20,
  "surchargeMinor"             INTEGER NOT NULL DEFAULT 0,
  "slotType"                   "DeliverySlotType" NOT NULL DEFAULT 'STANDARD',
  "freeDeliveryThresholdMinor" INTEGER NOT NULL DEFAULT 0,
  "isActive"                   BOOLEAN NOT NULL DEFAULT true,
  "notes"                      TEXT,
  "createdAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomDeliverySlot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EcomDeliverySlot_businessId_locationId_dayOfWeek_idx"
  ON "EcomDeliverySlot"("businessId", "locationId", "dayOfWeek");
CREATE INDEX "EcomDeliverySlot_businessId_locationId_specificDate_idx"
  ON "EcomDeliverySlot"("businessId", "locationId", "specificDate");
CREATE INDEX "EcomDeliverySlot_locationId_isActive_idx"
  ON "EcomDeliverySlot"("locationId", "isActive");

ALTER TABLE "EcomDeliverySlot"
  ADD CONSTRAINT "EcomDeliverySlot_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomDeliverySlot"
  ADD CONSTRAINT "EcomDeliverySlot_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── EcomDeliverySlotBooking ──────────────────────────────────────────────

CREATE TABLE "EcomDeliverySlotBooking" (
  "id"                    TEXT NOT NULL,
  "businessId"            TEXT NOT NULL,
  "slotId"                TEXT NOT NULL,
  "deliveryDate"          TIMESTAMP(3) NOT NULL,
  "orderId"               TEXT,
  "surchargeAppliedMinor" INTEGER NOT NULL DEFAULT 0,
  "status"                "SlotBookingStatus" NOT NULL DEFAULT 'HELD',
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomDeliverySlotBooking_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EcomDeliverySlotBooking_slotId_deliveryDate_orderId_key"
  ON "EcomDeliverySlotBooking"("slotId", "deliveryDate", "orderId");
CREATE INDEX "EcomDeliverySlotBooking_businessId_deliveryDate_idx"
  ON "EcomDeliverySlotBooking"("businessId", "deliveryDate");
CREATE INDEX "EcomDeliverySlotBooking_slotId_deliveryDate_idx"
  ON "EcomDeliverySlotBooking"("slotId", "deliveryDate");
CREATE INDEX "EcomDeliverySlotBooking_orderId_idx"
  ON "EcomDeliverySlotBooking"("orderId");

ALTER TABLE "EcomDeliverySlotBooking"
  ADD CONSTRAINT "EcomDeliverySlotBooking_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomDeliverySlotBooking"
  ADD CONSTRAINT "EcomDeliverySlotBooking_slotId_fkey"
    FOREIGN KEY ("slotId") REFERENCES "EcomDeliverySlot"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
