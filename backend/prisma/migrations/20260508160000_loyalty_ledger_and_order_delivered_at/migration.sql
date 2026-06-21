-- F3 — close the three honest gaps:
--   * loyalty engine (real ledger + balance derivation)
--   * customer notification preferences (JSON column on Customer)
--   * Order.deliveredAt timestamp (auto-stamped on DELIVERED transition)

ALTER TABLE "Order"
  ADD COLUMN "deliveredAt" TIMESTAMP(3);

ALTER TABLE "Customer"
  ADD COLUMN "notificationPrefs" JSONB;

CREATE TABLE "EcomLoyaltyLedger" (
  "id"         TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "type"       TEXT NOT NULL,
  "points"     INTEGER NOT NULL,
  "orderId"    TEXT,
  "note"       TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EcomLoyaltyLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EcomLoyaltyLedger_orderId_type_key"
  ON "EcomLoyaltyLedger"("orderId", "type");

CREATE INDEX "EcomLoyaltyLedger_businessId_customerId_createdAt_idx"
  ON "EcomLoyaltyLedger"("businessId", "customerId", "createdAt");

ALTER TABLE "EcomLoyaltyLedger"
  ADD CONSTRAINT "EcomLoyaltyLedger_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomLoyaltyLedger"
  ADD CONSTRAINT "EcomLoyaltyLedger_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
