-- Add personal calendar feed tokens so authenticated users/customers can
-- subscribe to a live ICS feed in Apple Calendar / Google Calendar.
ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "calendarFeedToken" TEXT;

ALTER TABLE "Customer"
ADD COLUMN IF NOT EXISTS "calendarFeedToken" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "User_calendarFeedToken_key"
ON "User"("calendarFeedToken");

CREATE UNIQUE INDEX IF NOT EXISTS "Customer_calendarFeedToken_key"
ON "Customer"("calendarFeedToken");

-- Shared inbox notifications for admins, staff, and customers.
CREATE TABLE IF NOT EXISTS "InboxNotification" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "userId" TEXT,
  "customerId" TEXT,
  "appointmentId" TEXT,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "ctaLabel" TEXT,
  "ctaUrl" TEXT,
  "metadata" JSONB,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboxNotification_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InboxNotification_businessId_fkey'
  ) THEN
    ALTER TABLE "InboxNotification"
    ADD CONSTRAINT "InboxNotification_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InboxNotification_userId_fkey'
  ) THEN
    ALTER TABLE "InboxNotification"
    ADD CONSTRAINT "InboxNotification_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InboxNotification_customerId_fkey'
  ) THEN
    ALTER TABLE "InboxNotification"
    ADD CONSTRAINT "InboxNotification_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InboxNotification_appointmentId_fkey'
  ) THEN
    ALTER TABLE "InboxNotification"
    ADD CONSTRAINT "InboxNotification_appointmentId_fkey"
    FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "InboxNotification_userId_readAt_createdAt_idx"
ON "InboxNotification"("userId", "readAt", "createdAt");

CREATE INDEX IF NOT EXISTS "InboxNotification_customerId_readAt_createdAt_idx"
ON "InboxNotification"("customerId", "readAt", "createdAt");

CREATE INDEX IF NOT EXISTS "InboxNotification_businessId_createdAt_idx"
ON "InboxNotification"("businessId", "createdAt");

CREATE INDEX IF NOT EXISTS "InboxNotification_appointmentId_createdAt_idx"
ON "InboxNotification"("appointmentId", "createdAt");
