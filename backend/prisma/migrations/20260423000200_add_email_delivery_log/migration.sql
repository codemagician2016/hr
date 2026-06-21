DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmailDeliveryStatus') THEN
    CREATE TYPE "EmailDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "EmailDelivery" (
  "id" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "category" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'AWS_SES',
  "senderEmail" TEXT,
  "recipientEmail" TEXT NOT NULL,
  "actualRecipientEmail" TEXT,
  "recipientName" TEXT,
  "subject" TEXT NOT NULL,
  "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "businessId" TEXT,
  "userId" TEXT,
  "customerId" TEXT,
  "appointmentId" TEXT,
  "subscriptionId" TEXT,
  "metadata" JSONB,
  "providerMessageId" TEXT,
  "errorMessage" TEXT,
  "overrideApplied" BOOLEAN NOT NULL DEFAULT false,
  "attemptedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EmailDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "EmailDelivery_eventKey_createdAt_idx" ON "EmailDelivery"("eventKey", "createdAt");
CREATE INDEX IF NOT EXISTS "EmailDelivery_status_createdAt_idx" ON "EmailDelivery"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "EmailDelivery_recipientEmail_createdAt_idx" ON "EmailDelivery"("recipientEmail", "createdAt");
CREATE INDEX IF NOT EXISTS "EmailDelivery_businessId_createdAt_idx" ON "EmailDelivery"("businessId", "createdAt");
CREATE INDEX IF NOT EXISTS "EmailDelivery_userId_createdAt_idx" ON "EmailDelivery"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "EmailDelivery_customerId_createdAt_idx" ON "EmailDelivery"("customerId", "createdAt");
CREATE INDEX IF NOT EXISTS "EmailDelivery_appointmentId_createdAt_idx" ON "EmailDelivery"("appointmentId", "createdAt");
CREATE INDEX IF NOT EXISTS "EmailDelivery_subscriptionId_createdAt_idx" ON "EmailDelivery"("subscriptionId", "createdAt");
