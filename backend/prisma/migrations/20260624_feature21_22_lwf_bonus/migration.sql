-- Feature 21 (Labour Welfare Fund) + Feature 22 (Statutory Bonus).
-- ADDITIVE only: two nullable Decimal columns on PayRunLine (LWF EE/ER rollups),
-- two nullable columns on StatutoryProfile (LWF state override + managerial flag),
-- one new enum value on RemittanceKind (IN_BONUS) and a new BonusCycleStatus enum,
-- and two new tables (BonusCycle, BonusAward). No changes to existing data, no
-- NOT NULL on an existing column, no backfill — safe on a live tenant (mirrors the
-- additive migrations of feature10/13/17/19). IF NOT EXISTS guards keep it idempotent.
-- RegistrationKind.LWF, RemittanceKind.IN_LWF and PayRunType.BONUS already exist.

-- ── Feature 21: PayRunLine LWF rollup columns (period-incident; null off-month) ──
ALTER TABLE "PayRunLine" ADD COLUMN IF NOT EXISTS "lwfEmployee" DECIMAL(15,2);
ALTER TABLE "PayRunLine" ADD COLUMN IF NOT EXISTS "lwfEmployer" DECIMAL(15,2);

-- ── Feature 21: StatutoryProfile LWF state override + managerial-exclusion flag ──
ALTER TABLE "StatutoryProfile" ADD COLUMN IF NOT EXISTS "lwfStateCode" TEXT;
ALTER TABLE "StatutoryProfile" ADD COLUMN IF NOT EXISTS "isManagerial" BOOLEAN DEFAULT false;

-- ── Feature 22: RemittanceKind.IN_BONUS (Form C / bonus-paid artifact row) ──
-- ADD VALUE cannot run inside a transaction block; IF NOT EXISTS makes it idempotent.
ALTER TYPE "RemittanceKind" ADD VALUE IF NOT EXISTS 'IN_BONUS';

-- ── Feature 22: BonusCycleStatus enum ──
DO $$ BEGIN
  CREATE TYPE "BonusCycleStatus" AS ENUM ('DRAFT', 'COMPUTED', 'APPROVED', 'PAID', 'FILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── Feature 22: BonusCycle (one per entity, accounting year) ──
CREATE TABLE IF NOT EXISTS "BonusCycle" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "accountingYear" TEXT NOT NULL,
    "rateBasisPoints" INTEGER NOT NULL DEFAULT 833,
    "calcCeilingMinor" BIGINT NOT NULL DEFAULT 700000,
    "minWageMonthlyMinor" BIGINT,
    "eligibilityCeilingMinor" BIGINT NOT NULL DEFAULT 2100000,
    "allocableSurplusMinor" BIGINT,
    "priorSetOnMinor" BIGINT NOT NULL DEFAULT 0,
    "status" "BonusCycleStatus" NOT NULL DEFAULT 'DRAFT',
    "dueDate" DATE NOT NULL,
    "payRunId" TEXT,
    "computedAt" TIMESTAMP(3),
    "computedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "BonusCycle_pkey" PRIMARY KEY ("id")
);

-- ── Feature 22: BonusAward (per-employee frozen snapshot ≈ PayRunLine) ──
CREATE TABLE IF NOT EXISTS "BonusAward" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "bonusCycleId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "ineligibleReason" TEXT,
    "monthlyBasicDaMinor" BIGINT NOT NULL DEFAULT 0,
    "cappedBaseMinor" BIGINT NOT NULL DEFAULT 0,
    "eligibleMonths" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "workedDays" INTEGER NOT NULL DEFAULT 0,
    "rateBasisPoints" INTEGER NOT NULL,
    "grossBonusMinor" BIGINT NOT NULL DEFAULT 0,
    "advancePaidMinor" BIGINT NOT NULL DEFAULT 0,
    "netBonusMinor" BIGINT NOT NULL DEFAULT 0,
    "computeTrace" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "BonusAward_pkey" PRIMARY KEY ("id")
);

-- Unique + indexes (exactly-once per (entity, FY); per-employee award; reporting).
CREATE UNIQUE INDEX IF NOT EXISTS "BonusCycle_businessId_entityId_accountingYear_key" ON "BonusCycle"("businessId", "entityId", "accountingYear");
CREATE INDEX IF NOT EXISTS "BonusCycle_businessId_status_dueDate_idx" ON "BonusCycle"("businessId", "status", "dueDate");
CREATE UNIQUE INDEX IF NOT EXISTS "BonusAward_businessId_bonusCycleId_employeeId_key" ON "BonusAward"("businessId", "bonusCycleId", "employeeId");
CREATE INDEX IF NOT EXISTS "BonusAward_businessId_bonusCycleId_eligible_idx" ON "BonusAward"("businessId", "bonusCycleId", "eligible");

-- Foreign keys (guarded so a re-apply on an already-migrated schema is a no-op).
DO $$ BEGIN
  ALTER TABLE "BonusCycle" ADD CONSTRAINT "BonusCycle_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "BonusCycle" ADD CONSTRAINT "BonusCycle_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "BonusAward" ADD CONSTRAINT "BonusAward_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "BonusAward" ADD CONSTRAINT "BonusAward_bonusCycleId_fkey" FOREIGN KEY ("bonusCycleId") REFERENCES "BonusCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "BonusAward" ADD CONSTRAINT "BonusAward_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
