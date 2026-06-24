-- Feature 2 — Multi-mode attendance capture policy (GEO_FENCE + IP_RESTRICTED + FACE).
-- PURELY ADDITIVE: three new enums (FaceMatchStatus / PunchReviewStatus /
-- CapturePolicyScope), three new tables (AttendanceCapturePolicy / LocationOfficeIp /
-- FaceEnrollment) and a set of NULLABLE / DEFAULTED capture columns on the existing
-- AttendancePunch. NO ALTER that drops / retypes / NOT-NULLs an existing column, NO
-- backfill — safe on a live tenant (mirrors the additive migrations of feature23..32).
-- IF NOT EXISTS / DO-block guards keep it idempotent for db-push parity + re-runs. The
-- attendance derivation engine (derive.js / service.js geofence math) is UNTOUCHED —
-- the capture module only sits on the punch-CREATE path and reuses the existing
-- recompute. GEO_FENCE reuses the per-Location geofence config (no new radius column).

-- ── Enums ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "FaceMatchStatus" AS ENUM (
    'MATCHED', 'NO_MATCH', 'NEEDS_REVIEW', 'NO_REFERENCE', 'SKIPPED'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "PunchReviewStatus" AS ENUM ('PENDING', 'CLEARED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "CapturePolicyScope" AS ENUM (
    'TENANT', 'ENTITY', 'LOCATION', 'EMPLOYEE_GROUP'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── AttendanceCapturePolicy — the per-tenant / per-scope mode policy ───────────
CREATE TABLE IF NOT EXISTS "AttendanceCapturePolicy" (
  "id"            TEXT NOT NULL,
  "businessId"    TEXT NOT NULL,
  "scope"         "CapturePolicyScope" NOT NULL DEFAULT 'TENANT',
  "scopeId"       TEXT,
  "name"          TEXT,
  "requireGeo"    BOOLEAN NOT NULL DEFAULT false,
  "requireIp"     BOOLEAN NOT NULL DEFAULT false,
  "requireFace"   BOOLEAN NOT NULL DEFAULT false,
  "geoEnforce"    BOOLEAN NOT NULL DEFAULT false,
  "ipEnforce"     BOOLEAN NOT NULL DEFAULT false,
  "faceEnforce"   BOOLEAN NOT NULL DEFAULT false,
  "faceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy"     TEXT,
  "version"       INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "AttendanceCapturePolicy_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  CREATE UNIQUE INDEX "AttendanceCapturePolicy_businessId_scope_scopeId_key"
    ON "AttendanceCapturePolicy" ("businessId", "scope", "scopeId");
EXCEPTION WHEN duplicate_table THEN null; WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE INDEX "AttendanceCapturePolicy_businessId_isActive_idx"
    ON "AttendanceCapturePolicy" ("businessId", "isActive");
EXCEPTION WHEN duplicate_table THEN null; WHEN duplicate_object THEN null; END $$;

-- ── LocationOfficeIp — the allowed office CIDR list per location ───────────────
CREATE TABLE IF NOT EXISTS "LocationOfficeIp" (
  "id"         TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "cidr"       TEXT NOT NULL,
  "label"      TEXT,
  "isActive"   BOOLEAN NOT NULL DEFAULT true,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy"  TEXT,
  CONSTRAINT "LocationOfficeIp_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  CREATE INDEX "LocationOfficeIp_businessId_locationId_isActive_idx"
    ON "LocationOfficeIp" ("businessId", "locationId", "isActive");
EXCEPTION WHEN duplicate_table THEN null; WHEN duplicate_object THEN null; END $$;

-- ── FaceEnrollment — the employee's enrolled reference face (one per employee) ─
CREATE TABLE IF NOT EXISTS "FaceEnrollment" (
  "id"         TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "imageUrl"   TEXT NOT NULL,
  "embedding"  JSONB,
  "matcher"    TEXT,
  "isActive"   BOOLEAN NOT NULL DEFAULT true,
  "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "enrolledBy" TEXT,
  "version"    INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "FaceEnrollment_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  CREATE UNIQUE INDEX "FaceEnrollment_businessId_employeeId_key"
    ON "FaceEnrollment" ("businessId", "employeeId");
EXCEPTION WHEN duplicate_table THEN null; WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE INDEX "FaceEnrollment_businessId_employeeId_isActive_idx"
    ON "FaceEnrollment" ("businessId", "employeeId", "isActive");
EXCEPTION WHEN duplicate_table THEN null; WHEN duplicate_object THEN null; END $$;

-- ── AttendancePunch — additive capture columns (all NULLABLE or DEFAULTED) ─────
ALTER TABLE "AttendancePunch"
  ADD COLUMN IF NOT EXISTS "captureMethods"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "ipAllowed"          BOOLEAN,
  ADD COLUMN IF NOT EXISTS "faceMatchScore"     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "faceMatched"        BOOLEAN,
  ADD COLUMN IF NOT EXISTS "faceMatchStatus"    "FaceMatchStatus",
  ADD COLUMN IF NOT EXISTS "captureFlagged"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "captureFlagReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "reviewStatus"       "PunchReviewStatus",
  ADD COLUMN IF NOT EXISTS "reviewedBy"         TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedAt"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reviewNote"         TEXT;

DO $$ BEGIN
  CREATE INDEX "AttendancePunch_businessId_captureFlagged_reviewStatus_idx"
    ON "AttendancePunch" ("businessId", "captureFlagged", "reviewStatus");
EXCEPTION WHEN duplicate_table THEN null; WHEN duplicate_object THEN null; END $$;
