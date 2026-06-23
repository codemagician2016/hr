-- Feature 5 (Compensation & CTC) — ADDITIVE ONLY. No rename/drop; historical pay
-- runs replay identically. Hand-authored + idempotent (IF NOT EXISTS / DO blocks)
-- so it applies cleanly to a clean migrate-deploy AND to the isolated hr_test
-- schema (bootstrapped via `prisma db push`).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. New enums (CompRevisionStatus, CompVisibility, increment-cycle enums).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "CompRevisionStatus" AS ENUM ('DRAFT','PROPOSED','APPROVED','EFFECTIVE','REJECTED','WITHDRAWN');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "CompVisibility" AS ENUM ('ABSOLUTE','RANGE_ONLY','SELF_ONLY','NONE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "IncrementCycleType" AS ENUM ('MERIT','PROMOTION','MARKET','COLA');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "IncrementCycleStatus" AS ENUM ('OPEN','LOCKED','CLOSED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ProposalStatus" AS ENUM ('DRAFT','SUBMITTED','APPROVED','REJECTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. SalaryComponent — derivation/clamp (all nullable/defaulted).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SalaryComponent" ADD COLUMN IF NOT EXISTS "derivationPass" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SalaryComponent" ADD COLUMN IF NOT EXISTS "floorValue" DECIMAL(15,2);
ALTER TABLE "SalaryComponent" ADD COLUMN IF NOT EXISTS "capValue" DECIMAL(15,2);
ALTER TABLE "SalaryComponent" ADD COLUMN IF NOT EXISTS "minWageFloorApplies" BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Grade — compa-ratio midpoint.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "Grade" ADD COLUMN IF NOT EXISTS "midSalary" DECIMAL(15,2);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. BusinessRole — salary-masking level (default NONE keeps existing roles
--    no-comp until explicitly granted; seed bumps system roles to their level).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "BusinessRole" ADD COLUMN IF NOT EXISTS "compVisibility" "CompVisibility" NOT NULL DEFAULT 'NONE';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. CompensationRevision — maker-checker status machine + SoD + letter (additive).
--    Default EFFECTIVE keeps the existing direct-write path (provisioning HIRE,
--    programmatic) valid.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "CompensationRevision" ADD COLUMN IF NOT EXISTS "status" "CompRevisionStatus" NOT NULL DEFAULT 'EFFECTIVE';
ALTER TABLE "CompensationRevision" ADD COLUMN IF NOT EXISTS "proposedById" TEXT;
ALTER TABLE "CompensationRevision" ADD COLUMN IF NOT EXISTS "approvedById" TEXT;
ALTER TABLE "CompensationRevision" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);
ALTER TABLE "CompensationRevision" ADD COLUMN IF NOT EXISTS "letterEnvelopeId" TEXT;
ALTER TABLE "CompensationRevision" ADD COLUMN IF NOT EXISTS "cycleId" TEXT;
ALTER TABLE "CompensationRevision" ADD COLUMN IF NOT EXISTS "sourcePeriodCode" TEXT;

CREATE INDEX IF NOT EXISTS "CompensationRevision_businessId_status_idx"
  ON "CompensationRevision" ("businessId", "status");

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. IncrementCycle / IncrementProposal — bulk maker-checker comp revisions.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "IncrementCycle" (
  "id"            TEXT NOT NULL,
  "businessId"    TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "type"          "IncrementCycleType" NOT NULL,
  "effectiveDate" DATE NOT NULL,
  "budgetMinor"   BIGINT,
  "status"        "IncrementCycleStatus" NOT NULL DEFAULT 'OPEN',
  "createdById"   TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IncrementCycle_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "IncrementCycle_businessId_status_idx"
  ON "IncrementCycle" ("businessId", "status");

CREATE TABLE IF NOT EXISTS "IncrementProposal" (
  "id"               TEXT NOT NULL,
  "businessId"       TEXT NOT NULL,
  "cycleId"          TEXT NOT NULL,
  "employeeId"       TEXT NOT NULL,
  "proposedById"     TEXT NOT NULL,
  "currentCtcMinor"  BIGINT,
  "proposedCtcMinor" BIGINT,
  "pctHike"          DECIMAL(8,4),
  "justification"    TEXT,
  "status"           "ProposalStatus" NOT NULL DEFAULT 'DRAFT',
  "revisionId"       TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IncrementProposal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IncrementProposal_cycleId_employeeId_key"
  ON "IncrementProposal" ("cycleId", "employeeId");
CREATE INDEX IF NOT EXISTS "IncrementProposal_businessId_cycleId_idx"
  ON "IncrementProposal" ("businessId", "cycleId");

-- FKs (guarded so a re-run / db-push'd hr_test does not error on duplicates).
DO $$ BEGIN
  ALTER TABLE "IncrementCycle"
    ADD CONSTRAINT "IncrementCycle_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "IncrementProposal"
    ADD CONSTRAINT "IncrementProposal_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "IncrementProposal"
    ADD CONSTRAINT "IncrementProposal_cycleId_fkey"
    FOREIGN KEY ("cycleId") REFERENCES "IncrementCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
