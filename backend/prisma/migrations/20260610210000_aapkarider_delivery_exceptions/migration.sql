-- AapkaRider structured delivery exceptions.
-- Current exception state lives on the delivery request for fast dispatcher
-- queues; every change is also recorded in EcomDeliveryRequestEvent.

ALTER TABLE "EcomDeliveryRequest"
  ADD COLUMN "exceptionCode" TEXT,
  ADD COLUMN "exceptionStatus" TEXT,
  ADD COLUMN "exceptionNote" TEXT,
  ADD COLUMN "exceptionOpenedAt" TIMESTAMP(3),
  ADD COLUMN "exceptionEscalatedAt" TIMESTAMP(3),
  ADD COLUMN "exceptionResolvedAt" TIMESTAMP(3),
  ADD COLUMN "exceptionResolutionNote" TEXT;

CREATE INDEX "EcomDeliveryRequest_businessId_exceptionStatus_createdAt_idx"
  ON "EcomDeliveryRequest"("businessId", "exceptionStatus", "createdAt");

CREATE INDEX "EcomDeliveryRequest_businessId_exceptionCode_createdAt_idx"
  ON "EcomDeliveryRequest"("businessId", "exceptionCode", "createdAt");
