-- Feature 27 — Auto-Arrear Engine (retro salary revision).
-- ADDITIVE only: one new enum (ArrearStatus) and two new tables (ArrearCycle,
-- ArrearMonth). No changes to existing data, no NOT NULL on an existing column,
-- no backfill — safe on a live tenant (mirrors the additive migrations of
-- feature21/22/24). IF NOT EXISTS / DO-block guards keep it idempotent. Reuses the
-- pre-existing PayRunType.ARREAR, PayRunInputKind.ARREAR, CompRevisionReason, and
-- CompensationRevision.sourcePeriodCode — no new enum values on those.

-- ── Feature 27: enum ──
DO $$ BEGIN
  CREATE TYPE "ArrearStatus" AS ENUM ('DRAFT', 'COMPUTED', 'APPROVED', 'PAID', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── Feature 27: ArrearCycle (one detected retro revision → one arrears computation) ──
CREATE TABLE IF NOT EXISTS "ArrearCycle" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "compensationRevisionId" TEXT NOT NULL,
    "revisionReason" "CompRevisionReason" NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "detectedInPeriod" TEXT NOT NULL,
    "taxYear" TEXT NOT NULL,
    "esiOnArrears" BOOLEAN NOT NULL DEFAULT true,
    "status" "ArrearStatus" NOT NULL DEFAULT 'DRAFT',
    "targetMode" TEXT,
    "grossArrearMinor" BIGINT NOT NULL DEFAULT 0,
    "pfArrearEeMinor" BIGINT NOT NULL DEFAULT 0,
    "pfArrearErMinor" BIGINT NOT NULL DEFAULT 0,
    "esiArrearEeMinor" BIGINT NOT NULL DEFAULT 0,
    "esiArrearErMinor" BIGINT NOT NULL DEFAULT 0,
    "s89ReliefMinor" BIGINT,
    "s89DatapointJson" JSONB,
    "payRunId" TEXT,
    "payRunInputItemId" TEXT,
    "computedAt" TIMESTAMP(3),
    "computedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ArrearCycle_pkey" PRIMARY KEY ("id")
);

-- ── Feature 27: ArrearMonth (per source-month recompute-vs-frozen diff) ──
CREATE TABLE IF NOT EXISTS "ArrearMonth" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "arrearCycleId" TEXT NOT NULL,
    "sourcePeriod" TEXT NOT NULL,
    "sourcePayRunId" TEXT NOT NULL,
    "paidGrossMinor" BIGINT NOT NULL,
    "recomputedGrossMinor" BIGINT NOT NULL,
    "deltaGrossMinor" BIGINT NOT NULL,
    "paidPfWageMinor" BIGINT NOT NULL,
    "recomputedPfWageMinor" BIGINT NOT NULL,
    "deltaPfWageMinor" BIGINT NOT NULL,
    "paidEsiWageMinor" BIGINT NOT NULL,
    "recomputedEsiWageMinor" BIGINT NOT NULL,
    "deltaEsiWageMinor" BIGINT NOT NULL,
    "pfArrearEeMinor" BIGINT NOT NULL DEFAULT 0,
    "pfArrearErMinor" BIGINT NOT NULL DEFAULT 0,
    "esiArrearEeMinor" BIGINT NOT NULL DEFAULT 0,
    "esiArrearErMinor" BIGINT NOT NULL DEFAULT 0,
    "componentDeltasJson" JSONB NOT NULL,
    "payableDays" DECIMAL(8,4) NOT NULL,
    "lopDays" DECIMAL(8,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArrearMonth_pkey" PRIMARY KEY ("id")
);

-- ── Indexes ──
CREATE UNIQUE INDEX IF NOT EXISTS "ArrearCycle_businessId_compensationRevisionId_key" ON "ArrearCycle"("businessId", "compensationRevisionId");
CREATE INDEX IF NOT EXISTS "ArrearCycle_businessId_employeeId_status_idx" ON "ArrearCycle"("businessId", "employeeId", "status");
CREATE INDEX IF NOT EXISTS "ArrearCycle_businessId_entityId_detectedInPeriod_idx" ON "ArrearCycle"("businessId", "entityId", "detectedInPeriod");
CREATE UNIQUE INDEX IF NOT EXISTS "ArrearMonth_arrearCycleId_sourcePeriod_key" ON "ArrearMonth"("arrearCycleId", "sourcePeriod");
CREATE INDEX IF NOT EXISTS "ArrearMonth_businessId_sourcePeriod_idx" ON "ArrearMonth"("businessId", "sourcePeriod");

-- ── Foreign keys (guarded so a re-apply on an already-migrated schema is a no-op) ──
DO $$ BEGIN
  ALTER TABLE "ArrearCycle" ADD CONSTRAINT "ArrearCycle_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ArrearCycle" ADD CONSTRAINT "ArrearCycle_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ArrearCycle" ADD CONSTRAINT "ArrearCycle_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ArrearMonth" ADD CONSTRAINT "ArrearMonth_arrearCycleId_fkey" FOREIGN KEY ("arrearCycleId") REFERENCES "ArrearCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
