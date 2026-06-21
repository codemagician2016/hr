CREATE TABLE "PaddleWebhookEvent" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "businessId" TEXT,
  "objectId" TEXT,
  "notificationId" TEXT,
  "occurredAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PaddleWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaddleWebhookEvent_eventId_key" ON "PaddleWebhookEvent"("eventId");
CREATE INDEX "PaddleWebhookEvent_status_createdAt_idx" ON "PaddleWebhookEvent"("status", "createdAt");
CREATE INDEX "PaddleWebhookEvent_eventType_createdAt_idx" ON "PaddleWebhookEvent"("eventType", "createdAt");
CREATE INDEX "PaddleWebhookEvent_businessId_createdAt_idx" ON "PaddleWebhookEvent"("businessId", "createdAt");
CREATE INDEX "PaddleWebhookEvent_objectId_eventType_idx" ON "PaddleWebhookEvent"("objectId", "eventType");

ALTER TABLE "PaddleWebhookEvent"
  ADD CONSTRAINT "PaddleWebhookEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
