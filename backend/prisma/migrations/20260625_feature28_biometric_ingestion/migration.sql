-- Feature 28 — Biometric / device punch ingestion (additive ingestion layer).
-- PURELY ADDITIVE: four new enums (DeviceVendor / DeviceDirectionMode / PollKind /
-- RawPunchStatus), one new enum VALUE on the existing ImportKind ('BIOMETRIC'),
-- three new tables (PunchDevice / DeviceEmployeeMap / RawPunchEvent) and TWO new
-- NULLABLE provenance columns on the existing AttendancePunch (punchDeviceId,
-- rawPunchEventId). NO ALTER that drops/retypes/NOT-NULLs an existing column, NO
-- backfill — safe on a live tenant (mirrors the additive migrations of
-- feature23/24/25/27/32). IF NOT EXISTS / DO-block guards keep it idempotent for
-- db-push parity + re-runs. The attendance derivation engine (derive.js /
-- service.js) is UNTOUCHED — these rows only feed the existing recompute.

-- ── Enums ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "DeviceVendor" AS ENUM (
    'ESSL', 'ZKTECO', 'MATRIX', 'MANTRA', 'CAMS', 'REALTIME', 'BIOMAX', 'GENERIC'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "DeviceDirectionMode" AS ENUM ('TRUST_DEVICE', 'DERIVE', 'ALL_IN');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "PollKind" AS ENUM ('SFTP', 'FOLDER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "RawPunchStatus" AS ENUM (
    'RECEIVED', 'MAPPED', 'MATERIALISED', 'UNMAPPED', 'UNKNOWN_DEVICE',
    'LOCKED', 'DUPLICATE', 'ERROR', 'IGNORED'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ImportKind gains BIOMETRIC (additive enum value; Postgres ADD VALUE is safe).
DO $$ BEGIN
  ALTER TYPE "ImportKind" ADD VALUE IF NOT EXISTS 'BIOMETRIC';
EXCEPTION WHEN others THEN null; END $$;

-- ── PunchDevice — the per-site device registry (trust + mapping anchor) ────────
CREATE TABLE IF NOT EXISTS "PunchDevice" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "locationId" TEXT,
    "vendor" "DeviceVendor" NOT NULL,
    "adapterKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serialNumber" TEXT,
    "directionMode" "DeviceDirectionMode" NOT NULL DEFAULT 'DERIVE',
    "dedupWindowSec" INTEGER NOT NULL DEFAULT 60,
    "fallbackToEmployeeCode" BOOLEAN NOT NULL DEFAULT true,
    "clockOffsetSec" INTEGER NOT NULL DEFAULT 0,
    "ingestSecretHash" TEXT,
    "ingestSecretLast4" TEXT,
    "pollKind" "PollKind",
    "pollConfigJson" JSONB,
    "pollCursor" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "expectedSilenceMin" INTEGER,
    "timezone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "PunchDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PunchDevice_businessId_serialNumber_key"
  ON "PunchDevice" ("businessId", "serialNumber");
CREATE INDEX IF NOT EXISTS "PunchDevice_businessId_entityId_isActive_idx"
  ON "PunchDevice" ("businessId", "entityId", "isActive");
CREATE INDEX IF NOT EXISTS "PunchDevice_businessId_locationId_idx"
  ON "PunchDevice" ("businessId", "locationId");

-- ── DeviceEmployeeMap — device-code (enroll-no/PIN) → DriftHR employee ─────────
CREATE TABLE IF NOT EXISTS "DeviceEmployeeMap" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "deviceId" TEXT,
    "deviceCode" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    CONSTRAINT "DeviceEmployeeMap_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DeviceEmployeeMap_businessId_deviceId_deviceCode_key"
  ON "DeviceEmployeeMap" ("businessId", "deviceId", "deviceCode");
CREATE INDEX IF NOT EXISTS "DeviceEmployeeMap_businessId_employeeId_idx"
  ON "DeviceEmployeeMap" ("businessId", "employeeId");

-- ── RawPunchEvent — the IMMUTABLE raw inbound event (audit + dedup spine) ──────
CREATE TABLE IF NOT EXISTS "RawPunchEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "deviceId" TEXT,
    "importJobId" TEXT,
    "deviceCode" TEXT NOT NULL,
    "localTimeRaw" TEXT NOT NULL,
    "punchAt" TIMESTAMP(3) NOT NULL,
    "rawDirection" TEXT,
    "resolvedType" "PunchType",
    "rawPayloadJson" JSONB NOT NULL,
    "status" "RawPunchStatus" NOT NULL DEFAULT 'RECEIVED',
    "reason" TEXT,
    "employeeId" TEXT,
    "attendancePunchId" TEXT,
    "dedupKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RawPunchEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "RawPunchEvent_businessId_dedupKey_key"
  ON "RawPunchEvent" ("businessId", "dedupKey");
CREATE INDEX IF NOT EXISTS "RawPunchEvent_businessId_deviceId_punchAt_idx"
  ON "RawPunchEvent" ("businessId", "deviceId", "punchAt");
CREATE INDEX IF NOT EXISTS "RawPunchEvent_businessId_status_idx"
  ON "RawPunchEvent" ("businessId", "status");
CREATE INDEX IF NOT EXISTS "RawPunchEvent_businessId_employeeId_punchAt_idx"
  ON "RawPunchEvent" ("businessId", "employeeId", "punchAt");

-- ── AttendancePunch — TWO new NULLABLE provenance columns (existing rows safe) ─
ALTER TABLE "AttendancePunch" ADD COLUMN IF NOT EXISTS "punchDeviceId" TEXT;
ALTER TABLE "AttendancePunch" ADD COLUMN IF NOT EXISTS "rawPunchEventId" TEXT;

-- ── Foreign keys (guarded; onDelete mirrors the Prisma schema) ─────────────────
DO $$ BEGIN
  ALTER TABLE "PunchDevice" ADD CONSTRAINT "PunchDevice_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "PunchDevice" ADD CONSTRAINT "PunchDevice_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "PunchDevice" ADD CONSTRAINT "PunchDevice_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "DeviceEmployeeMap" ADD CONSTRAINT "DeviceEmployeeMap_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "DeviceEmployeeMap" ADD CONSTRAINT "DeviceEmployeeMap_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "PunchDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "DeviceEmployeeMap" ADD CONSTRAINT "DeviceEmployeeMap_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "RawPunchEvent" ADD CONSTRAINT "RawPunchEvent_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "RawPunchEvent" ADD CONSTRAINT "RawPunchEvent_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "PunchDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
