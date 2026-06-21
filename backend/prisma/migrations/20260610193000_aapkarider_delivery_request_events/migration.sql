-- AapkaRider delivery-scoped audit timeline.
-- One immutable row per lifecycle/support event so manual/API deliveries have
-- the same operational traceability as native Sitepresso orders.

CREATE TABLE "EcomDeliveryRequestEvent" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "deliveryRequestId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT,
  "message" TEXT,
  "payload" JSONB,
  "actorUserId" TEXT,
  "actorSource" TEXT NOT NULL DEFAULT 'SYSTEM',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EcomDeliveryRequestEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EcomDeliveryRequestEvent_businessId_deliveryRequestId_createdAt_idx"
  ON "EcomDeliveryRequestEvent"("businessId", "deliveryRequestId", "createdAt");

CREATE INDEX "EcomDeliveryRequestEvent_deliveryRequestId_createdAt_idx"
  ON "EcomDeliveryRequestEvent"("deliveryRequestId", "createdAt");

CREATE INDEX "EcomDeliveryRequestEvent_businessId_createdAt_idx"
  ON "EcomDeliveryRequestEvent"("businessId", "createdAt");

CREATE INDEX "EcomDeliveryRequestEvent_businessId_kind_createdAt_idx"
  ON "EcomDeliveryRequestEvent"("businessId", "kind", "createdAt");

ALTER TABLE "EcomDeliveryRequestEvent"
  ADD CONSTRAINT "EcomDeliveryRequestEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EcomDeliveryRequestEvent"
  ADD CONSTRAINT "EcomDeliveryRequestEvent_deliveryRequestId_fkey"
  FOREIGN KEY ("deliveryRequestId") REFERENCES "EcomDeliveryRequest"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
