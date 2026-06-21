-- Doctor product v2 — Phase 1 data model. Additive + retry-safe.

-- ── New tables ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Specialty" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Specialty_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Specialty_businessId_slug_key" ON "Specialty"("businessId","slug");
CREATE INDEX IF NOT EXISTS "Specialty_businessId_isActive_sortOrder_idx" ON "Specialty"("businessId","isActive","sortOrder");

CREATE TABLE IF NOT EXISTS "AppointmentReminder" (
  "id" TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'DAY_BEFORE',
  "channel" TEXT NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "sentAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppointmentReminder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AppointmentReminder_appointmentId_kind_key" ON "AppointmentReminder"("appointmentId","kind");
CREATE INDEX IF NOT EXISTS "AppointmentReminder_status_scheduledFor_idx" ON "AppointmentReminder"("status","scheduledFor");
CREATE INDEX IF NOT EXISTS "AppointmentReminder_appointmentId_idx" ON "AppointmentReminder"("appointmentId");

CREATE TABLE IF NOT EXISTS "ConsentRecord" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "granted" BOOLEAN NOT NULL DEFAULT true,
  "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "withdrawnAt" TIMESTAMP(3),
  "source" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ConsentRecord_businessId_customerId_purpose_idx" ON "ConsentRecord"("businessId","customerId","purpose");

CREATE TABLE IF NOT EXISTS "Review" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "appointmentId" TEXT,
  "customerId" TEXT,
  "staffId" TEXT,
  "rating" INTEGER NOT NULL,
  "body" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Review_appointmentId_key" ON "Review"("appointmentId");
CREATE INDEX IF NOT EXISTS "Review_businessId_status_createdAt_idx" ON "Review"("businessId","status","createdAt");
CREATE INDEX IF NOT EXISTS "Review_staffId_idx" ON "Review"("staffId");

-- ── Column additions ─────────────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "specialtyId" TEXT;
ALTER TABLE "StaffSchedule" ADD COLUMN IF NOT EXISTS "locationId" TEXT;
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "requiresPrepayment" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "paymentGateway" TEXT;
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "gatewayOrderId" TEXT;
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "appointmentReminderConfig" JSONB;

CREATE INDEX IF NOT EXISTS "User_specialtyId_idx" ON "User"("specialtyId");
CREATE INDEX IF NOT EXISTS "StaffSchedule_locationId_idx" ON "StaffSchedule"("locationId");

-- ── Foreign keys (retry-safe) ────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "Specialty" ADD CONSTRAINT "Specialty_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "User" ADD CONSTRAINT "User_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "StaffSchedule" ADD CONSTRAINT "StaffSchedule_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "AppointmentReminder" ADD CONSTRAINT "AppointmentReminder_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "Review" ADD CONSTRAINT "Review_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "Review" ADD CONSTRAINT "Review_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "Review" ADD CONSTRAINT "Review_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "Review" ADD CONSTRAINT "Review_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
