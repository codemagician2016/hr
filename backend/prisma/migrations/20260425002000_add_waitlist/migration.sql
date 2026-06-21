-- Customer waitlist. Capture demand when slots are full so cancels +
-- reschedules can recapture lost bookings via auto-notify cron.

CREATE TYPE "WaitlistStatus" AS ENUM ('PENDING', 'NOTIFIED', 'CONVERTED', 'DISMISSED', 'EXPIRED');

CREATE TABLE "Waitlist" (
  "id"                 TEXT PRIMARY KEY,
  "businessId"         TEXT NOT NULL REFERENCES "Business"("id"),
  "customerId"         TEXT REFERENCES "Customer"("id"),
  "name"               TEXT NOT NULL,
  "email"              TEXT NOT NULL,
  "phone"              TEXT,
  "serviceId"          TEXT REFERENCES "Service"("id"),
  "staffId"            TEXT REFERENCES "User"("id"),
  "preferredDate"      TIMESTAMP(3) NOT NULL,
  "preferredStartTime" TEXT,
  "preferredEndTime"   TEXT,
  "notes"              TEXT,
  "status"             "WaitlistStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt"          TIMESTAMP(3) NOT NULL,
  "notifiedAt"         TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL
);

CREATE INDEX "Waitlist_businessId_status_preferredDate_idx" ON "Waitlist"("businessId", "status", "preferredDate");
CREATE INDEX "Waitlist_customerId_idx" ON "Waitlist"("customerId");
