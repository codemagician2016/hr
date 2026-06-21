-- AapkaRider cash settlement ledger for COD/in-person rider handovers.

CREATE TYPE "EcomDeliveryCashSettlementStatus" AS ENUM ('DRAFT', 'SETTLED', 'VOID');

CREATE TABLE "EcomDeliveryCashSettlement" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "riderId" TEXT,
  "locationId" TEXT,
  "status" "EcomDeliveryCashSettlementStatus" NOT NULL DEFAULT 'SETTLED',
  "settlementDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fromAt" TIMESTAMP(3) NOT NULL,
  "toAt" TIMESTAMP(3) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "expectedCashMinor" INTEGER NOT NULL DEFAULT 0,
  "countedCashMinor" INTEGER NOT NULL DEFAULT 0,
  "varianceMinor" INTEGER NOT NULL DEFAULT 0,
  "deliveryCount" INTEGER NOT NULL DEFAULT 0,
  "deliveryIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "reference" TEXT,
  "notes" TEXT,
  "settledByUserId" TEXT,
  "voidedAt" TIMESTAMP(3),
  "voidedByUserId" TEXT,
  "voidReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EcomDeliveryCashSettlement_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EcomDeliveryCashSettlement"
  ADD CONSTRAINT "EcomDeliveryCashSettlement_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomDeliveryCashSettlement"
  ADD CONSTRAINT "EcomDeliveryCashSettlement_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "EcomRider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EcomDeliveryCashSettlement"
  ADD CONSTRAINT "EcomDeliveryCashSettlement_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "EcomDeliveryCashSettlement_businessId_riderId_settlementDate_idx"
  ON "EcomDeliveryCashSettlement"("businessId", "riderId", "settlementDate");

CREATE INDEX "EcomDeliveryCashSettlement_businessId_locationId_settlementDate_idx"
  ON "EcomDeliveryCashSettlement"("businessId", "locationId", "settlementDate");

CREATE INDEX "EcomDeliveryCashSettlement_businessId_status_createdAt_idx"
  ON "EcomDeliveryCashSettlement"("businessId", "status", "createdAt");
