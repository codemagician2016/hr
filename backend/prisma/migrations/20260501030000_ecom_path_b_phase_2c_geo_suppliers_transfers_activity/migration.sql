-- ECOMMERCE Path B Phase 2c (2026-05-01) — purely additive migration.
--
--   * Geo:       EcomServiceCity / EcomDeliveryZone
--   * Supply:    EcomSupplier / EcomGoodsReceiptNote / EcomGoodsReceiptItem
--   * Transfers: EcomInventoryTransfer / EcomInventoryTransferItem
--   * Audit:     EcomActivityEvent (cross-cutting log; complements
--                EcomOrderEvent + EcomReturnEvent which are subject-scoped)
--
-- All new tables; no existing column or constraint modifications.
-- STATIC + APPOINTMENT verticals are unaffected.

-- ─── EcomServiceCity ──────────────────────────────────────────────────────

CREATE TABLE "EcomServiceCity" (
  "id"              TEXT NOT NULL,
  "businessId"      TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "slug"            TEXT NOT NULL,
  "countryCode"     TEXT NOT NULL,
  "region"          TEXT,
  "timezone"        TEXT,
  "status"          TEXT NOT NULL DEFAULT 'LIVE',
  "taxJurisdiction" TEXT,
  "currency"        TEXT,
  "defaultLocale"   TEXT,
  "brandOverrides"  JSONB,
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"       INTEGER NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomServiceCity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EcomServiceCity_businessId_slug_key"
  ON "EcomServiceCity"("businessId", "slug");
CREATE INDEX "EcomServiceCity_businessId_isActive_sortOrder_idx"
  ON "EcomServiceCity"("businessId", "isActive", "sortOrder");

ALTER TABLE "EcomServiceCity"
  ADD CONSTRAINT "EcomServiceCity_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── EcomDeliveryZone ─────────────────────────────────────────────────────

CREATE TABLE "EcomDeliveryZone" (
  "id"                         TEXT NOT NULL,
  "businessId"                 TEXT NOT NULL,
  "cityId"                     TEXT NOT NULL,
  "primaryLocationId"          TEXT,
  "name"                       TEXT NOT NULL,
  "slug"                       TEXT NOT NULL,
  "postcodes"                  JSONB NOT NULL DEFAULT '[]',
  "polygon"                    JSONB,
  "deliveryFeeMinor"           INTEGER NOT NULL DEFAULT 0,
  "freeDeliveryThresholdMinor" INTEGER NOT NULL DEFAULT 0,
  "expressSurchargeMinor"      INTEGER NOT NULL DEFAULT 0,
  "maxInFlightOrders"          INTEGER NOT NULL DEFAULT 0,
  "promiseMinutes"             INTEGER,
  "isActive"                   BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"                  INTEGER NOT NULL DEFAULT 0,
  "createdAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomDeliveryZone_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EcomDeliveryZone_businessId_cityId_slug_key"
  ON "EcomDeliveryZone"("businessId", "cityId", "slug");
CREATE INDEX "EcomDeliveryZone_businessId_isActive_idx"
  ON "EcomDeliveryZone"("businessId", "isActive");
CREATE INDEX "EcomDeliveryZone_cityId_isActive_idx"
  ON "EcomDeliveryZone"("cityId", "isActive");
CREATE INDEX "EcomDeliveryZone_primaryLocationId_idx"
  ON "EcomDeliveryZone"("primaryLocationId");

ALTER TABLE "EcomDeliveryZone"
  ADD CONSTRAINT "EcomDeliveryZone_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomDeliveryZone"
  ADD CONSTRAINT "EcomDeliveryZone_cityId_fkey"
    FOREIGN KEY ("cityId") REFERENCES "EcomServiceCity"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── EcomSupplier ─────────────────────────────────────────────────────────

CREATE TABLE "EcomSupplier" (
  "id"                TEXT NOT NULL,
  "businessId"        TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "contactName"       TEXT,
  "email"             TEXT,
  "phone"             TEXT,
  "addressLine1"      TEXT,
  "addressLine2"      TEXT,
  "city"              TEXT,
  "region"            TEXT,
  "postalCode"        TEXT,
  "countryCode"       TEXT,
  "taxIdType"         TEXT,
  "taxId"             TEXT,
  "bankAccountName"   TEXT,
  "bankAccountNumber" TEXT,
  "bankSortCode"      TEXT,
  "bankIfsc"          TEXT,
  "paymentTerms"      TEXT,
  "currency"          TEXT,
  "notes"             TEXT,
  "isActive"          BOOLEAN NOT NULL DEFAULT true,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomSupplier_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EcomSupplier_businessId_isActive_idx"
  ON "EcomSupplier"("businessId", "isActive");
CREATE INDEX "EcomSupplier_businessId_name_idx"
  ON "EcomSupplier"("businessId", "name");

ALTER TABLE "EcomSupplier"
  ADD CONSTRAINT "EcomSupplier_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── EcomGoodsReceiptNote (GRN) + items ───────────────────────────────────

CREATE TABLE "EcomGoodsReceiptNote" (
  "id"                TEXT NOT NULL,
  "businessId"        TEXT NOT NULL,
  "code"              TEXT NOT NULL,
  "supplierId"        TEXT,
  "locationId"        TEXT NOT NULL,
  "receivedAt"        TIMESTAMP(3) NOT NULL,
  "supplierInvoiceNo" TEXT,
  "purchaseOrderRef"  TEXT,
  "invoiceTotalMinor" INTEGER NOT NULL DEFAULT 0,
  "status"            TEXT NOT NULL DEFAULT 'DRAFT',
  "postedAt"          TIMESTAMP(3),
  "postedByUserId"    TEXT,
  "attachmentUrl"     TEXT,
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomGoodsReceiptNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EcomGoodsReceiptNote_code_key"
  ON "EcomGoodsReceiptNote"("code");
CREATE INDEX "EcomGoodsReceiptNote_businessId_status_receivedAt_idx"
  ON "EcomGoodsReceiptNote"("businessId", "status", "receivedAt");
CREATE INDEX "EcomGoodsReceiptNote_locationId_receivedAt_idx"
  ON "EcomGoodsReceiptNote"("locationId", "receivedAt");
CREATE INDEX "EcomGoodsReceiptNote_supplierId_idx"
  ON "EcomGoodsReceiptNote"("supplierId");

ALTER TABLE "EcomGoodsReceiptNote"
  ADD CONSTRAINT "EcomGoodsReceiptNote_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomGoodsReceiptNote"
  ADD CONSTRAINT "EcomGoodsReceiptNote_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "EcomSupplier"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "EcomGoodsReceiptItem" (
  "id"               TEXT NOT NULL,
  "grnId"            TEXT NOT NULL,
  "productId"        TEXT,
  "productName"      TEXT NOT NULL,
  "productSku"       TEXT,
  "quantityOrdered"  INTEGER NOT NULL DEFAULT 0,
  "quantityReceived" INTEGER NOT NULL,
  "unitCostMinor"    INTEGER NOT NULL DEFAULT 0,
  "taxMinor"         INTEGER NOT NULL DEFAULT 0,
  "lineTotalMinor"   INTEGER NOT NULL DEFAULT 0,
  "batchNumber"      TEXT,
  "expiresAt"        TIMESTAMP(3),
  "adjustmentId"     TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomGoodsReceiptItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EcomGoodsReceiptItem_grnId_idx" ON "EcomGoodsReceiptItem"("grnId");
CREATE INDEX "EcomGoodsReceiptItem_productId_idx" ON "EcomGoodsReceiptItem"("productId");

ALTER TABLE "EcomGoodsReceiptItem"
  ADD CONSTRAINT "EcomGoodsReceiptItem_grnId_fkey"
    FOREIGN KEY ("grnId") REFERENCES "EcomGoodsReceiptNote"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── EcomInventoryTransfer + items ────────────────────────────────────────

CREATE TABLE "EcomInventoryTransfer" (
  "id"                TEXT NOT NULL,
  "businessId"        TEXT NOT NULL,
  "code"              TEXT NOT NULL,
  "fromLocationId"    TEXT NOT NULL,
  "toLocationId"      TEXT NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'DRAFT',
  "riderId"           TEXT,
  "shippedAt"         TIMESTAMP(3),
  "receivedAt"        TIMESTAMP(3),
  "initiatedByUserId" TEXT,
  "receivedByUserId"  TEXT,
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomInventoryTransfer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EcomInventoryTransfer_code_key"
  ON "EcomInventoryTransfer"("code");
CREATE INDEX "EcomInventoryTransfer_businessId_status_shippedAt_idx"
  ON "EcomInventoryTransfer"("businessId", "status", "shippedAt");
CREATE INDEX "EcomInventoryTransfer_fromLocationId_shippedAt_idx"
  ON "EcomInventoryTransfer"("fromLocationId", "shippedAt");
CREATE INDEX "EcomInventoryTransfer_toLocationId_receivedAt_idx"
  ON "EcomInventoryTransfer"("toLocationId", "receivedAt");
CREATE INDEX "EcomInventoryTransfer_riderId_idx"
  ON "EcomInventoryTransfer"("riderId");

ALTER TABLE "EcomInventoryTransfer"
  ADD CONSTRAINT "EcomInventoryTransfer_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EcomInventoryTransferItem" (
  "id"                  TEXT NOT NULL,
  "transferId"          TEXT NOT NULL,
  "productId"           TEXT,
  "productName"         TEXT NOT NULL,
  "productSku"          TEXT,
  "quantityShipped"     INTEGER NOT NULL,
  "quantityReceived"    INTEGER NOT NULL DEFAULT 0,
  "shipAdjustmentId"    TEXT,
  "receiveAdjustmentId" TEXT,
  "notes"               TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomInventoryTransferItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EcomInventoryTransferItem_transferId_idx"
  ON "EcomInventoryTransferItem"("transferId");
CREATE INDEX "EcomInventoryTransferItem_productId_idx"
  ON "EcomInventoryTransferItem"("productId");

ALTER TABLE "EcomInventoryTransferItem"
  ADD CONSTRAINT "EcomInventoryTransferItem_transferId_fkey"
    FOREIGN KEY ("transferId") REFERENCES "EcomInventoryTransfer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── EcomActivityEvent (cross-cutting audit log) ──────────────────────────

CREATE TABLE "EcomActivityEvent" (
  "id"          TEXT NOT NULL,
  "businessId"  TEXT NOT NULL,
  "eventKey"    TEXT NOT NULL,
  "area"        TEXT NOT NULL,
  "severity"    TEXT NOT NULL DEFAULT 'INFO',
  "actorUserId" TEXT,
  "actorName"   TEXT,
  "actorRole"   TEXT,
  "actorSource" TEXT NOT NULL DEFAULT 'ADMIN',
  "targetType"  TEXT,
  "targetId"    TEXT,
  "targetCode"  TEXT,
  "locationId"  TEXT,
  "message"     TEXT,
  "payload"     JSONB,
  "ipAddress"   TEXT,
  "userAgent"   TEXT,
  "outcome"     TEXT NOT NULL DEFAULT 'SUCCESS',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EcomActivityEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EcomActivityEvent_businessId_createdAt_idx"
  ON "EcomActivityEvent"("businessId", "createdAt");
CREATE INDEX "EcomActivityEvent_businessId_area_createdAt_idx"
  ON "EcomActivityEvent"("businessId", "area", "createdAt");
CREATE INDEX "EcomActivityEvent_businessId_severity_createdAt_idx"
  ON "EcomActivityEvent"("businessId", "severity", "createdAt");
CREATE INDEX "EcomActivityEvent_businessId_actorUserId_createdAt_idx"
  ON "EcomActivityEvent"("businessId", "actorUserId", "createdAt");
CREATE INDEX "EcomActivityEvent_businessId_targetType_targetId_idx"
  ON "EcomActivityEvent"("businessId", "targetType", "targetId");

ALTER TABLE "EcomActivityEvent"
  ADD CONSTRAINT "EcomActivityEvent_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
