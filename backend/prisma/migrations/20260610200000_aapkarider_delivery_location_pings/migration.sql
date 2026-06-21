-- AapkaRider live rider location pings.
-- Kept separate from delivery audit events because GPS can be high volume.

CREATE TABLE "EcomDeliveryLocationPing" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "deliveryRequestId" TEXT,
  "riderId" TEXT,
  "routeId" TEXT,
  "routeStopId" TEXT,
  "lat" DOUBLE PRECISION NOT NULL,
  "lng" DOUBLE PRECISION NOT NULL,
  "accuracyMeters" DOUBLE PRECISION,
  "headingDegrees" DOUBLE PRECISION,
  "speedMetersPerSecond" DOUBLE PRECISION,
  "batteryPct" INTEGER,
  "source" TEXT NOT NULL DEFAULT 'RIDER_APP',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EcomDeliveryLocationPing_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EcomDeliveryLocationPing_businessId_createdAt_idx"
  ON "EcomDeliveryLocationPing"("businessId", "createdAt");

CREATE INDEX "EcomDeliveryLocationPing_deliveryRequestId_createdAt_idx"
  ON "EcomDeliveryLocationPing"("deliveryRequestId", "createdAt");

CREATE INDEX "EcomDeliveryLocationPing_riderId_createdAt_idx"
  ON "EcomDeliveryLocationPing"("riderId", "createdAt");

CREATE INDEX "EcomDeliveryLocationPing_routeId_createdAt_idx"
  ON "EcomDeliveryLocationPing"("routeId", "createdAt");

CREATE INDEX "EcomDeliveryLocationPing_routeStopId_createdAt_idx"
  ON "EcomDeliveryLocationPing"("routeStopId", "createdAt");

ALTER TABLE "EcomDeliveryLocationPing"
  ADD CONSTRAINT "EcomDeliveryLocationPing_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomDeliveryLocationPing"
  ADD CONSTRAINT "EcomDeliveryLocationPing_deliveryRequestId_fkey"
  FOREIGN KEY ("deliveryRequestId") REFERENCES "EcomDeliveryRequest"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EcomDeliveryLocationPing"
  ADD CONSTRAINT "EcomDeliveryLocationPing_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "EcomRider"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EcomDeliveryLocationPing"
  ADD CONSTRAINT "EcomDeliveryLocationPing_routeId_fkey"
  FOREIGN KEY ("routeId") REFERENCES "EcomDeliveryRoute"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EcomDeliveryLocationPing"
  ADD CONSTRAINT "EcomDeliveryLocationPing_routeStopId_fkey"
  FOREIGN KEY ("routeStopId") REFERENCES "EcomDeliveryRouteStop"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
