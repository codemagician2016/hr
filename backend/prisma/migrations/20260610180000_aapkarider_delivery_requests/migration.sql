-- AapkaRider product core: delivery requests independent of ecommerce orders.
-- One row represents a delivery contract from Sitepresso, external API/POS, or
-- manual/offline entry. Existing route/stop tables remain the dispatch layer.

CREATE TYPE "DeliveryRequestSource" AS ENUM (
  'SITEPRESSO',
  'API',
  'MANUAL'
);

CREATE TYPE "DeliveryRequestStatus" AS ENUM (
  'PENDING',
  'READY_FOR_DISPATCH',
  'ASSIGNED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'ARRIVED',
  'DELIVERED',
  'ATTEMPTED_FAILED',
  'CANCELLED',
  'RETURNED'
);

CREATE TABLE "EcomDeliveryRequest" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "locationId" TEXT,
  "orderId" TEXT,
  "source" "DeliveryRequestSource" NOT NULL DEFAULT 'MANUAL',
  "sourceRef" TEXT,
  "channel" TEXT,
  "status" "DeliveryRequestStatus" NOT NULL DEFAULT 'PENDING',
  "priority" TEXT NOT NULL DEFAULT 'NORMAL',
  "riderId" TEXT,
  "customerName" TEXT NOT NULL,
  "customerPhone" TEXT,
  "customerEmail" TEXT,
  "pickupName" TEXT,
  "pickupAddress1" TEXT,
  "pickupAddress2" TEXT,
  "pickupCity" TEXT,
  "pickupState" TEXT,
  "pickupPostalCode" TEXT,
  "pickupCountry" TEXT,
  "pickupLat" DOUBLE PRECISION,
  "pickupLng" DOUBLE PRECISION,
  "dropoffName" TEXT,
  "dropoffAddress1" TEXT,
  "dropoffAddress2" TEXT,
  "dropoffCity" TEXT,
  "dropoffState" TEXT,
  "dropoffPostalCode" TEXT,
  "dropoffCountry" TEXT,
  "dropoffLat" DOUBLE PRECISION,
  "dropoffLng" DOUBLE PRECISION,
  "items" JSONB NOT NULL DEFAULT '[]',
  "packageNote" TEXT,
  "deliverySlotLabel" TEXT,
  "requestedPickupAt" TIMESTAMP(3),
  "requestedDropoffAt" TIMESTAMP(3),
  "promisedAt" TIMESTAMP(3),
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "paymentMethod" TEXT,
  "cashToCollectMinor" INTEGER NOT NULL DEFAULT 0,
  "cashCollectedMinor" INTEGER NOT NULL DEFAULT 0,
  "cashReceivedMinor" INTEGER NOT NULL DEFAULT 0,
  "cashChangeDueMinor" INTEGER NOT NULL DEFAULT 0,
  "paymentReference" TEXT,
  "paymentNote" TEXT,
  "trackingToken" TEXT NOT NULL,
  "proofPhotoUrl" TEXT,
  "proofSignatureUrl" TEXT,
  "proofOtp" TEXT,
  "customerRating" INTEGER,
  "customerFeedback" TEXT,
  "failureReason" TEXT,
  "notes" TEXT,
  "assignedAt" TIMESTAMP(3),
  "pickedUpAt" TIMESTAMP(3),
  "arrivedAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "returnedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "EcomDeliveryRequest_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EcomDeliveryRouteStop"
  ADD COLUMN "deliveryRequestId" TEXT;

CREATE UNIQUE INDEX "EcomDeliveryRequest_trackingToken_key"
  ON "EcomDeliveryRequest"("trackingToken");

CREATE UNIQUE INDEX "EcomDeliveryRequest_businessId_source_sourceRef_key"
  ON "EcomDeliveryRequest"("businessId", "source", "sourceRef");

CREATE INDEX "EcomDeliveryRequest_businessId_status_createdAt_idx"
  ON "EcomDeliveryRequest"("businessId", "status", "createdAt");

CREATE INDEX "EcomDeliveryRequest_businessId_locationId_status_idx"
  ON "EcomDeliveryRequest"("businessId", "locationId", "status");

CREATE INDEX "EcomDeliveryRequest_businessId_riderId_status_idx"
  ON "EcomDeliveryRequest"("businessId", "riderId", "status");

CREATE INDEX "EcomDeliveryRequest_orderId_idx"
  ON "EcomDeliveryRequest"("orderId");

CREATE INDEX "EcomDeliveryRequest_sourceRef_idx"
  ON "EcomDeliveryRequest"("sourceRef");

CREATE INDEX "EcomDeliveryRouteStop_deliveryRequestId_idx"
  ON "EcomDeliveryRouteStop"("deliveryRequestId");

ALTER TABLE "EcomDeliveryRequest"
  ADD CONSTRAINT "EcomDeliveryRequest_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomDeliveryRequest"
  ADD CONSTRAINT "EcomDeliveryRequest_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EcomDeliveryRequest"
  ADD CONSTRAINT "EcomDeliveryRequest_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EcomDeliveryRequest"
  ADD CONSTRAINT "EcomDeliveryRequest_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "EcomRider"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EcomDeliveryRouteStop"
  ADD CONSTRAINT "EcomDeliveryRouteStop_deliveryRequestId_fkey"
  FOREIGN KEY ("deliveryRequestId") REFERENCES "EcomDeliveryRequest"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
