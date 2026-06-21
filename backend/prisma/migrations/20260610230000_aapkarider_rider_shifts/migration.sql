-- AapkaRider rider shift/check-in ledger.

CREATE TYPE "EcomRiderShiftStatus" AS ENUM ('OPEN', 'CLOSED', 'VOID');

CREATE TABLE "EcomRiderShift" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "riderId" TEXT NOT NULL,
  "locationId" TEXT,
  "status" "EcomRiderShiftStatus" NOT NULL DEFAULT 'OPEN',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  "startLat" DOUBLE PRECISION,
  "startLng" DOUBLE PRECISION,
  "endLat" DOUBLE PRECISION,
  "endLng" DOUBLE PRECISION,
  "cashFloatMinor" INTEGER NOT NULL DEFAULT 0,
  "cashInHandMinor" INTEGER NOT NULL DEFAULT 0,
  "startBatteryPct" INTEGER,
  "endBatteryPct" INTEGER,
  "startNote" TEXT,
  "endNote" TEXT,
  "startedByUserId" TEXT,
  "endedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EcomRiderShift_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EcomRiderShift"
  ADD CONSTRAINT "EcomRiderShift_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomRiderShift"
  ADD CONSTRAINT "EcomRiderShift_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "EcomRider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomRiderShift"
  ADD CONSTRAINT "EcomRiderShift_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "EcomRiderShift_businessId_riderId_status_idx"
  ON "EcomRiderShift"("businessId", "riderId", "status");

CREATE INDEX "EcomRiderShift_businessId_locationId_startedAt_idx"
  ON "EcomRiderShift"("businessId", "locationId", "startedAt");

CREATE INDEX "EcomRiderShift_businessId_status_startedAt_idx"
  ON "EcomRiderShift"("businessId", "status", "startedAt");

CREATE UNIQUE INDEX "EcomRiderShift_one_open_per_rider_idx"
  ON "EcomRiderShift"("businessId", "riderId")
  WHERE "status" = 'OPEN';
