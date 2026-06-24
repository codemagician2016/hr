-- Feature 29 — Shift management (rosters, rotation, swap), India.
-- ADDITIVE only: three new enums for the roster cell, one enum for swap consent,
-- one new enum VALUE (SHIFT_SWAP) on the existing WorkflowModule, one nullable
-- boolean (with a default) on the EXISTING Employee table, and three new tables
-- (RosterDay, RotationTemplate, ShiftSwapRequest). No destructive change, no
-- backfill, no NOT NULL on a pre-existing column without a default — safe on a
-- live tenant. IF NOT EXISTS / DO-block guards keep it idempotent (db-push parity).
--
-- A RosterDay is the per-employee-per-day roster CELL (the writable grid unit);
-- derive.js reads PUBLISHED rows first, so a no-roster tenant is byte-identical.

-- CreateEnum — roster cell day type. OFF surfaces as WEEKLY_OFF in derive.
DO $$ BEGIN
  CREATE TYPE "RosterDayType" AS ENUM ('WORK', 'OFF');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateEnum — DRAFT until published; derive ignores DRAFT (invariant I4).
DO $$ BEGIN
  CREATE TYPE "RosterStatus" AS ENUM ('DRAFT', 'PUBLISHED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateEnum — provenance of a roster cell (for the grid + audit).
DO $$ BEGIN
  CREATE TYPE "RosterSource" AS ENUM ('ROTATION', 'MANUAL', 'SWAP');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateEnum — shift-swap counterparty consent gate (B accepts before manager chain).
DO $$ BEGIN
  CREATE TYPE "ConsentStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- AlterEnum — shift-swap rides its own WorkflowModule so its consumer never
-- collides with any other module's handler. Additive; idempotent.
ALTER TYPE "WorkflowModule" ADD VALUE IF NOT EXISTS 'SHIFT_SWAP';

-- AlterTable — women/graveyard night-shift consent. Default false = must opt in.
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "nightShiftEligible" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable — the per-employee-per-day roster cell.
CREATE TABLE IF NOT EXISTS "RosterDay" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "dayType" "RosterDayType" NOT NULL DEFAULT 'WORK',
    "shiftPatternId" TEXT,
    "status" "RosterStatus" NOT NULL DEFAULT 'DRAFT',
    "source" "RosterSource" NOT NULL DEFAULT 'MANUAL',
    "rotationTemplateId" TEXT,
    "swapRequestId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RosterDay_pkey" PRIMARY KEY ("id")
);

-- One roster cell per employee per day (idempotent generate/upsert).
CREATE UNIQUE INDEX IF NOT EXISTS "RosterDay_businessId_employeeId_date_key"
    ON "RosterDay"("businessId", "employeeId", "date");

-- Grid page (a date column across employees).
CREATE INDEX IF NOT EXISTS "RosterDay_businessId_date_status_idx"
    ON "RosterDay"("businessId", "date", "status");

-- ESS my-week + derive read.
CREATE INDEX IF NOT EXISTS "RosterDay_businessId_employeeId_date_idx"
    ON "RosterDay"("businessId", "employeeId", "date");

-- CreateTable — the reusable rotation ring.
CREATE TABLE IF NOT EXISTS "RotationTemplate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slotsJson" JSONB NOT NULL,
    "cycleLength" INTEGER NOT NULL,
    "anchorDate" DATE NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RotationTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RotationTemplate_businessId_code_key"
    ON "RotationTemplate"("businessId", "code");

CREATE INDEX IF NOT EXISTS "RotationTemplate_businessId_isActive_idx"
    ON "RotationTemplate"("businessId", "isActive");

-- CreateTable — the shift-swap request (rides the F10 SHIFT_SWAP approval).
CREATE TABLE IF NOT EXISTS "ShiftSwapRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "requesterEmployeeId" TEXT NOT NULL,
    "counterpartyEmployeeId" TEXT NOT NULL,
    "requesterDate" DATE NOT NULL,
    "counterpartyDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "counterpartyConsent" "ConsentStatus" NOT NULL DEFAULT 'PENDING',
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "approvalRequestId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftSwapRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ShiftSwapRequest_businessId_requesterEmployeeId_requesterDate_idx"
    ON "ShiftSwapRequest"("businessId", "requesterEmployeeId", "requesterDate");

CREATE INDEX IF NOT EXISTS "ShiftSwapRequest_businessId_counterpartyEmployeeId_counterpa_idx"
    ON "ShiftSwapRequest"("businessId", "counterpartyEmployeeId", "counterpartyDate");

CREATE INDEX IF NOT EXISTS "ShiftSwapRequest_businessId_status_idx"
    ON "ShiftSwapRequest"("businessId", "status");

-- AddForeignKey — RosterDay: tenant + employee cascade; shiftPattern RESTRICT
-- (a referenced pattern cannot be hard-deleted out from under a roster cell).
DO $$ BEGIN
  ALTER TABLE "RosterDay"
    ADD CONSTRAINT "RosterDay_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "RosterDay"
    ADD CONSTRAINT "RosterDay_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "RosterDay"
    ADD CONSTRAINT "RosterDay_shiftPatternId_fkey"
    FOREIGN KEY ("shiftPatternId") REFERENCES "ShiftPattern"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey — RotationTemplate tenant cascade.
DO $$ BEGIN
  ALTER TABLE "RotationTemplate"
    ADD CONSTRAINT "RotationTemplate_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey — ShiftSwapRequest tenant + both employees cascade.
DO $$ BEGIN
  ALTER TABLE "ShiftSwapRequest"
    ADD CONSTRAINT "ShiftSwapRequest_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "ShiftSwapRequest"
    ADD CONSTRAINT "ShiftSwapRequest_requesterEmployeeId_fkey"
    FOREIGN KEY ("requesterEmployeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "ShiftSwapRequest"
    ADD CONSTRAINT "ShiftSwapRequest_counterpartyEmployeeId_fkey"
    FOREIGN KEY ("counterpartyEmployeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
