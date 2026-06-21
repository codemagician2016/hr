ALTER TABLE "RestaurantSettings"
  ADD COLUMN "depositMode" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN "minimumSpendEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "minimumSpendAmount" DOUBLE PRECISION,
  ADD COLUMN "minimumSpendPerPerson" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "prepaidEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "prepaidAmount" DOUBLE PRECISION,
  ADD COLUMN "cancellationFeeAmount" DOUBLE PRECISION,
  ADD COLUMN "noShowFeeAmount" DOUBLE PRECISION,
  ADD COLUMN "policyText" TEXT,
  ADD COLUMN "preorderEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "RestaurantReservation"
  ADD COLUMN "reservationType" TEXT NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "experienceName" TEXT,
  ADD COLUMN "depositAmount" DOUBLE PRECISION,
  ADD COLUMN "minimumSpendAmount" DOUBLE PRECISION,
  ADD COLUMN "minimumSpendPerPerson" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "prepaidAmount" DOUBLE PRECISION,
  ADD COLUMN "policyAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "preorderItems" JSONB,
  ADD COLUMN "paymentNote" TEXT,
  ADD COLUMN "quotedWaitMinutes" INTEGER;

CREATE INDEX "RestaurantReservation_businessId_reservationType_createdAt_idx"
  ON "RestaurantReservation"("businessId", "reservationType", "createdAt");
