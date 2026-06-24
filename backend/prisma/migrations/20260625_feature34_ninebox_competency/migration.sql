-- Feature 34 — 9-box grid + competency framework (talent-review depth F8 deferred).
-- ADDITIVE only: 5 new enums, 5 new tables (Competency, RoleCompetency,
-- NineBoxPlacement, NineBoxMove, TalentTag), one discriminator column on the EXISTING
-- CalibrationSession (default RATING → every live row keeps its behaviour), and one
-- optional JSON config column on ReviewCycle. No NOT NULL on a pre-existing column
-- without a default, no destructive change, no backfill — safe on a live tenant.
-- IF NOT EXISTS / DO-block guards keep it idempotent for db-push parity + re-runs.

-- ── Enums ──────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "CompetencyCategory" AS ENUM ('CORE', 'LEADERSHIP', 'FUNCTIONAL', 'BEHAVIOURAL', 'TECHNICAL');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "PlacementStatus" AS ENUM ('DRAFT', 'PROPOSED', 'CALIBRATED', 'FINALIZED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "TalentTagKind" AS ENUM ('HIPO', 'FLIGHT_RISK', 'PROMOTION_READY', 'SUCCESSOR', 'KEY_PERSON');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "Readiness" AS ENUM ('READY_NOW', 'READY_1_2_YR', 'READY_3_PLUS_YR');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "CalibrationKind" AS ENUM ('RATING', 'NINE_BOX', 'BOTH');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── AlterTable: CalibrationSession discriminator (default RATING = back-compat) ──
ALTER TABLE "CalibrationSession" ADD COLUMN IF NOT EXISTS "kind" "CalibrationKind" NOT NULL DEFAULT 'RATING';

-- ── AlterTable: ReviewCycle per-cycle 9-box config (optional JSON) ──────────────
ALTER TABLE "ReviewCycle" ADD COLUMN IF NOT EXISTS "nineBoxConfigJson" JSONB;

-- ── Competency library ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Competency" (
  "id"          TEXT NOT NULL,
  "businessId"  TEXT NOT NULL,
  "code"        TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "category"    "CompetencyCategory" NOT NULL DEFAULT 'BEHAVIOURAL',
  "description" TEXT,
  "scaleId"     TEXT,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "version"     INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Competency_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Competency_businessId_code_key" ON "Competency"("businessId", "code");
CREATE INDEX IF NOT EXISTS "Competency_businessId_category_isActive_idx" ON "Competency"("businessId", "category", "isActive");

-- ── Role → competency map ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RoleCompetency" (
  "id"            TEXT NOT NULL,
  "businessId"    TEXT NOT NULL,
  "competencyId"  TEXT NOT NULL,
  "roleKey"       TEXT NOT NULL,
  "expectedLevel" DECIMAL(4,2) NOT NULL,
  "weight"        DECIMAL(5,2),
  "version"       INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RoleCompetency_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "RoleCompetency_businessId_competencyId_roleKey_key" ON "RoleCompetency"("businessId", "competencyId", "roleKey");
CREATE INDEX IF NOT EXISTS "RoleCompetency_businessId_roleKey_idx" ON "RoleCompetency"("businessId", "roleKey");

-- ── 9-box placement ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "NineBoxPlacement" (
  "id"                TEXT NOT NULL,
  "businessId"        TEXT NOT NULL,
  "cycleId"           TEXT NOT NULL,
  "employeeId"        TEXT NOT NULL,
  "reviewInstanceId"  TEXT,
  "performanceBand"   INTEGER NOT NULL,
  "potentialRating"   DECIMAL(4,2),
  "potentialBand"     INTEGER,
  "box"               INTEGER,
  "status"            "PlacementStatus" NOT NULL DEFAULT 'DRAFT',
  "potentialScaleId"  TEXT,
  "idpNote"           TEXT,
  "sharedWithSubject" BOOLEAN NOT NULL DEFAULT false,
  "version"           INTEGER NOT NULL DEFAULT 0,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NineBoxPlacement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "NineBoxPlacement_businessId_cycleId_employeeId_key" ON "NineBoxPlacement"("businessId", "cycleId", "employeeId");
CREATE INDEX IF NOT EXISTS "NineBoxPlacement_businessId_cycleId_box_idx" ON "NineBoxPlacement"("businessId", "cycleId", "box");
CREATE INDEX IF NOT EXISTS "NineBoxPlacement_businessId_cycleId_status_idx" ON "NineBoxPlacement"("businessId", "cycleId", "status");

-- ── 9-box move ledger (append-only) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "NineBoxMove" (
  "id"            TEXT NOT NULL,
  "businessId"    TEXT NOT NULL,
  "placementId"   TEXT NOT NULL,
  "sessionId"     TEXT,
  "fromBox"       INTEGER,
  "toBox"         INTEGER NOT NULL,
  "fromPotential" DECIMAL(4,2),
  "toPotential"   DECIMAL(4,2),
  "reason"        TEXT NOT NULL,
  "byEmployeeId"  TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NineBoxMove_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "NineBoxMove_businessId_placementId_idx" ON "NineBoxMove"("businessId", "placementId");
CREATE INDEX IF NOT EXISTS "NineBoxMove_businessId_sessionId_idx" ON "NineBoxMove"("businessId", "sessionId");

-- ── Talent pool / succession tag ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TalentTag" (
  "id"                  TEXT NOT NULL,
  "businessId"          TEXT NOT NULL,
  "employeeId"          TEXT NOT NULL,
  "kind"                "TalentTagKind" NOT NULL,
  "positionRef"         TEXT,
  "readiness"           "Readiness",
  "note"                TEXT,
  "cycleId"             TEXT,
  "isActive"            BOOLEAN NOT NULL DEFAULT true,
  "createdByEmployeeId" TEXT,
  "version"             INTEGER NOT NULL DEFAULT 0,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TalentTag_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TalentTag_businessId_employeeId_kind_isActive_idx" ON "TalentTag"("businessId", "employeeId", "kind", "isActive");
CREATE INDEX IF NOT EXISTS "TalentTag_businessId_kind_isActive_idx" ON "TalentTag"("businessId", "kind", "isActive");

-- ── Foreign keys (guarded; ON DELETE mirrors the Prisma schema) ─────────────────
DO $$ BEGIN
  ALTER TABLE "Competency" ADD CONSTRAINT "Competency_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "RoleCompetency" ADD CONSTRAINT "RoleCompetency_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "RoleCompetency" ADD CONSTRAINT "RoleCompetency_competencyId_fkey"
    FOREIGN KEY ("competencyId") REFERENCES "Competency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "NineBoxPlacement" ADD CONSTRAINT "NineBoxPlacement_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "NineBoxPlacement" ADD CONSTRAINT "NineBoxPlacement_cycleId_fkey"
    FOREIGN KEY ("cycleId") REFERENCES "ReviewCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "NineBoxPlacement" ADD CONSTRAINT "NineBoxPlacement_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "NineBoxPlacement" ADD CONSTRAINT "NineBoxPlacement_reviewInstanceId_fkey"
    FOREIGN KEY ("reviewInstanceId") REFERENCES "PerformanceReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "NineBoxMove" ADD CONSTRAINT "NineBoxMove_placementId_fkey"
    FOREIGN KEY ("placementId") REFERENCES "NineBoxPlacement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "TalentTag" ADD CONSTRAINT "TalentTag_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "TalentTag" ADD CONSTRAINT "TalentTag_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
