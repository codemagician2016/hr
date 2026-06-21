-- Additive storage for the safe Letterhead2 rollout and universal front-desk
-- walk-in workflow. Existing letterheadSettings remains untouched.
ALTER TABLE "BusinessContent"
  ADD COLUMN IF NOT EXISTS "letterhead2Settings" TEXT;

ALTER TABLE "Appointment"
  ADD COLUMN IF NOT EXISTS "bookingChannel" TEXT NOT NULL DEFAULT 'ONLINE',
  ADD COLUMN IF NOT EXISTS "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
  ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT,
  ADD COLUMN IF NOT EXISTS "paidAmount" DOUBLE PRECISION DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "paymentReference" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentReceivedById" TEXT;

CREATE INDEX IF NOT EXISTS "Appointment_businessId_bookingChannel_date_idx"
  ON "Appointment"("businessId", "bookingChannel", "date");

CREATE INDEX IF NOT EXISTS "Appointment_businessId_paymentStatus_date_idx"
  ON "Appointment"("businessId", "paymentStatus", "date");
