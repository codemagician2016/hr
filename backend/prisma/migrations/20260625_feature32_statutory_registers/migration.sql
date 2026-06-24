-- Feature 32 — Statutory Attendance/Wage Registers (muster roll + Form registers).
-- India-only, READ-ONLY projection layer over already-frozen data. This migration
-- is PURELY ADDITIVE: three new enums (RegisterKind / RegisterCadence /
-- RegisterSource), one new DEFINITION table (RegisterDefinition — the per-state,
-- effective-dated form→columns map, mirroring ComplianceObligation) and one new
-- artefact-log table (RegisterExport — audit + S3 archive of a generated register).
-- NO ALTER of any source table (Attendance / AttendancePayInput / PayRunLine /
-- PayRunLineComponent / Payslip / LeaveTransaction / LeaveBalance), NO NOT NULL on
-- an existing column, NO backfill — safe on a live tenant (mirrors the additive
-- migrations of feature23/24/25/27). IF NOT EXISTS / DO-block guards keep it
-- idempotent for db-push parity + re-runs.

-- ── Enums ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "RegisterKind" AS ENUM (
    'MUSTER_ROLL', 'WAGE_REGISTER', 'MUSTER_WAGE_COMBINED', 'OVERTIME_REGISTER',
    'LEAVE_REGISTER', 'FINES_REGISTER', 'EMPLOYEE_REGISTER', 'PF_ANNUAL', 'ESI_REGISTER'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "RegisterCadence" AS ENUM ('PERIOD', 'HALF_YEARLY', 'ANNUAL', 'SNAPSHOT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "RegisterSource" AS ENUM ('ATTENDANCE', 'PAYRUN', 'LEAVE', 'EMPLOYEE', 'PAYRUN_ANNUAL');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── RegisterDefinition — the per-state, effective-dated form→columns map ───────
CREATE TABLE IF NOT EXISTS "RegisterDefinition" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "kind" "RegisterKind" NOT NULL,
    "formCode" TEXT NOT NULL,
    "formLabel" TEXT NOT NULL,
    "actLabel" TEXT NOT NULL,
    "stateCode" TEXT,
    "cadence" "RegisterCadence" NOT NULL,
    "source" "RegisterSource" NOT NULL,
    "columns" JSONB NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RegisterDefinition_pkey" PRIMARY KEY ("id")
);

-- ── RegisterExport — generated-artefact log (audit + optional S3 archive) ──────
CREATE TABLE IF NOT EXISTS "RegisterExport" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "definitionId" TEXT,
    "entityId" TEXT NOT NULL,
    "kind" "RegisterKind" NOT NULL,
    "formCode" TEXT NOT NULL,
    "stateCode" TEXT,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "sourceRefs" JSONB NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "controlTotals" JSONB,
    "fileUrl" TEXT,
    "fileHash" TEXT,
    "generatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegisterExport_pkey" PRIMARY KEY ("id")
);

-- ── Indexes + natural key ─────────────────────────────────────────────────────
-- NOTE: a Postgres UNIQUE constraint treats NULLs as distinct, so the natural key
-- (entityId NULL = tenant-default, stateCode NULL = central) lets a tenant-default
-- row and an entity-override row coexist — matched by the projector's resolution.
CREATE UNIQUE INDEX IF NOT EXISTS "RegisterDefinition_businessId_entityId_kind_formCode_stateCode_effectiveFrom_key"
    ON "RegisterDefinition" ("businessId", "entityId", "kind", "formCode", "stateCode", "effectiveFrom");
CREATE INDEX IF NOT EXISTS "RegisterDefinition_businessId_isActive_kind_idx"
    ON "RegisterDefinition" ("businessId", "isActive", "kind");

CREATE INDEX IF NOT EXISTS "RegisterExport_businessId_entityId_kind_periodStart_idx"
    ON "RegisterExport" ("businessId", "entityId", "kind", "periodStart");
CREATE INDEX IF NOT EXISTS "RegisterExport_businessId_definitionId_idx"
    ON "RegisterExport" ("businessId", "definitionId");

-- ── Foreign keys (guarded; tenant + entity scoping; definition SetNull/Restrict) ─
DO $$ BEGIN
  ALTER TABLE "RegisterDefinition"
    ADD CONSTRAINT "RegisterDefinition_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "RegisterDefinition"
    ADD CONSTRAINT "RegisterDefinition_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "RegisterExport"
    ADD CONSTRAINT "RegisterExport_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "RegisterExport"
    ADD CONSTRAINT "RegisterExport_definitionId_fkey"
    FOREIGN KEY ("definitionId") REFERENCES "RegisterDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "RegisterExport"
    ADD CONSTRAINT "RegisterExport_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
