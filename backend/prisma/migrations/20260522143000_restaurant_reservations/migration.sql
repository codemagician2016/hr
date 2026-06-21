-- Restaurant Reservations theme: table inventory, dining service periods,
-- and reservation-to-table assignments. Additive only; existing appointment
-- vertical flows continue to use the staff-based slot engine.

CREATE TABLE IF NOT EXISTS "RestaurantSettings" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "slotIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
  "defaultTurnMinutes" INTEGER NOT NULL DEFAULT 90,
  "minAdvanceMinutes" INTEGER NOT NULL DEFAULT 60,
  "maxPartySizeOnline" INTEGER NOT NULL DEFAULT 12,
  "graceMinutes" INTEGER NOT NULL DEFAULT 15,
  "holdMinutes" INTEGER NOT NULL DEFAULT 10,
  "onlineBookingEnabled" BOOLEAN NOT NULL DEFAULT true,
  "depositRequired" BOOLEAN NOT NULL DEFAULT false,
  "depositAmount" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RestaurantSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RestaurantSettings_businessId_key"
  ON "RestaurantSettings"("businessId");

ALTER TABLE "RestaurantSettings"
  ADD CONSTRAINT "RestaurantSettings_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "RestaurantDiningArea" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "locationId" TEXT,
  "name" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "onlineBookable" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RestaurantDiningArea_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RestaurantDiningArea_businessId_locationId_isActive_idx"
  ON "RestaurantDiningArea"("businessId", "locationId", "isActive");

ALTER TABLE "RestaurantDiningArea"
  ADD CONSTRAINT "RestaurantDiningArea_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RestaurantDiningArea"
  ADD CONSTRAINT "RestaurantDiningArea_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "RestaurantTable" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "areaId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "minCovers" INTEGER NOT NULL DEFAULT 1,
  "maxCovers" INTEGER NOT NULL,
  "shape" TEXT NOT NULL DEFAULT 'ROUND',
  "x" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "y" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "width" DOUBLE PRECISION NOT NULL DEFAULT 80,
  "height" DOUBLE PRECISION NOT NULL DEFAULT 80,
  "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "onlineBookable" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RestaurantTable_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RestaurantTable_businessId_areaId_label_key"
  ON "RestaurantTable"("businessId", "areaId", "label");

CREATE INDEX IF NOT EXISTS "RestaurantTable_businessId_isActive_onlineBookable_idx"
  ON "RestaurantTable"("businessId", "isActive", "onlineBookable");

ALTER TABLE "RestaurantTable"
  ADD CONSTRAINT "RestaurantTable_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RestaurantTable"
  ADD CONSTRAINT "RestaurantTable_areaId_fkey"
  FOREIGN KEY ("areaId") REFERENCES "RestaurantDiningArea"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "RestaurantServicePeriod" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "locationId" TEXT,
  "areaId" TEXT,
  "dayOfWeek" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "startTime" TEXT NOT NULL,
  "endTime" TEXT NOT NULL,
  "slotIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
  "turnMinutes" INTEGER NOT NULL DEFAULT 90,
  "flowCoverLimit" INTEGER,
  "onlineInventoryPercent" INTEGER NOT NULL DEFAULT 100,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RestaurantServicePeriod_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RestaurantServicePeriod_businessId_locationId_dayOfWeek_isActive_idx"
  ON "RestaurantServicePeriod"("businessId", "locationId", "dayOfWeek", "isActive");

ALTER TABLE "RestaurantServicePeriod"
  ADD CONSTRAINT "RestaurantServicePeriod_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RestaurantServicePeriod"
  ADD CONSTRAINT "RestaurantServicePeriod_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RestaurantServicePeriod"
  ADD CONSTRAINT "RestaurantServicePeriod_areaId_fkey"
  FOREIGN KEY ("areaId") REFERENCES "RestaurantDiningArea"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "RestaurantReservation" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "locationId" TEXT,
  "partySize" INTEGER NOT NULL,
  "guestName" TEXT NOT NULL,
  "guestEmail" TEXT,
  "guestPhone" TEXT,
  "seatingPreference" TEXT,
  "occasion" TEXT,
  "dietaryNotes" TEXT,
  "source" TEXT NOT NULL DEFAULT 'ONLINE',
  "arrivalStatus" TEXT NOT NULL DEFAULT 'RESERVED',
  "tableNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RestaurantReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RestaurantReservation_appointmentId_key"
  ON "RestaurantReservation"("appointmentId");

CREATE INDEX IF NOT EXISTS "RestaurantReservation_businessId_arrivalStatus_createdAt_idx"
  ON "RestaurantReservation"("businessId", "arrivalStatus", "createdAt");

CREATE INDEX IF NOT EXISTS "RestaurantReservation_businessId_locationId_partySize_idx"
  ON "RestaurantReservation"("businessId", "locationId", "partySize");

ALTER TABLE "RestaurantReservation"
  ADD CONSTRAINT "RestaurantReservation_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RestaurantReservation"
  ADD CONSTRAINT "RestaurantReservation_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RestaurantReservation"
  ADD CONSTRAINT "RestaurantReservation_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "RestaurantReservationTable" (
  "id" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "tableId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RestaurantReservationTable_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RestaurantReservationTable_reservationId_tableId_key"
  ON "RestaurantReservationTable"("reservationId", "tableId");

CREATE INDEX IF NOT EXISTS "RestaurantReservationTable_tableId_idx"
  ON "RestaurantReservationTable"("tableId");

ALTER TABLE "RestaurantReservationTable"
  ADD CONSTRAINT "RestaurantReservationTable_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "RestaurantReservation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RestaurantReservationTable"
  ADD CONSTRAINT "RestaurantReservationTable_tableId_fkey"
  FOREIGN KEY ("tableId") REFERENCES "RestaurantTable"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
