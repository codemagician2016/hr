-- Order — delivery slot snapshot fields. Soft FK to EcomDeliverySlot
-- (deactivation must not break historical orders). Capacity is enforced
-- via EcomDeliverySlotBooking, which already exists.
ALTER TABLE "Order"
  ADD COLUMN "deliverySlotId"             TEXT,
  ADD COLUMN "deliveryDate"               TIMESTAMP(3),
  ADD COLUMN "deliverySlotLabel"          TEXT,
  ADD COLUMN "deliverySlotSurchargeMinor" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Order_deliverySlotId_deliveryDate_idx"
  ON "Order"("deliverySlotId", "deliveryDate");
