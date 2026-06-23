-- Feature 11 — Reimbursement/Claims + Travel & Outdoor-duty + custom policy engine.
-- ADDITIVE, non-breaking. Every statement is guarded (IF NOT EXISTS / DO blocks)
-- so the migration is idempotent: it applies cleanly to a fresh DB AND to a DB that
-- already received an equivalent `prisma db push` (the hr_test case). No column is
-- dropped, no existing data touched; all new columns are nullable or defaulted so
-- existing EXP-#### claims keep working (claimType→REIMBURSEMENT, verdict→NO_POLICY).

-- ── Enums ──────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "ClaimType" AS ENUM ('REIMBURSEMENT', 'TRAVEL');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "TravelStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "TransportMode" AS ENUM ('PUBLIC_TRANSPORT', 'SELF_CAR', 'TAXI_CAB', 'TRAIN', 'FLIGHT', 'OTHER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "PolicyVerdict" AS ENUM ('OK', 'FLAGGED', 'AUTO_REJECTED', 'NO_POLICY');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "PolicyEnforcement" AS ENUM ('FLAG', 'HARD');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "PerDiemBand" AS ENUM ('FULL_24H', 'HALF_12H', 'HALF_DAY');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── ExpenseClaim field additions ───────────────────────────────────────────────
ALTER TABLE "ExpenseClaim" ADD COLUMN IF NOT EXISTS "claimType" "ClaimType" NOT NULL DEFAULT 'REIMBURSEMENT';
ALTER TABLE "ExpenseClaim" ADD COLUMN IF NOT EXISTS "travelRequestId" TEXT;
ALTER TABLE "ExpenseClaim" ADD COLUMN IF NOT EXISTS "approvalRequestId" TEXT;
ALTER TABLE "ExpenseClaim" ADD COLUMN IF NOT EXISTS "policyVerdict" "PolicyVerdict" NOT NULL DEFAULT 'NO_POLICY';
ALTER TABLE "ExpenseClaim" ADD COLUMN IF NOT EXISTS "policyId" TEXT;
ALTER TABLE "ExpenseClaim" ADD COLUMN IF NOT EXISTS "policySnapshotJson" JSONB;

-- ── ExpenseClaimLine field additions ───────────────────────────────────────────
ALTER TABLE "ExpenseClaimLine" ADD COLUMN IF NOT EXISTS "categoryId" TEXT;
ALTER TABLE "ExpenseClaimLine" ADD COLUMN IF NOT EXISTS "policyStatus" "PolicyVerdict" NOT NULL DEFAULT 'NO_POLICY';
ALTER TABLE "ExpenseClaimLine" ADD COLUMN IF NOT EXISTS "policyReason" TEXT;
ALTER TABLE "ExpenseClaimLine" ADD COLUMN IF NOT EXISTS "appliedCap" DECIMAL(15,2);
ALTER TABLE "ExpenseClaimLine" ADD COLUMN IF NOT EXISTS "transportMode" "TransportMode";
ALTER TABLE "ExpenseClaimLine" ADD COLUMN IF NOT EXISTS "distanceKm" DECIMAL(8,2);
ALTER TABLE "ExpenseClaimLine" ADD COLUMN IF NOT EXISTS "nights" INTEGER;
ALTER TABLE "ExpenseClaimLine" ADD COLUMN IF NOT EXISTS "durationBand" "PerDiemBand";
ALTER TABLE "ExpenseClaimLine" ADD COLUMN IF NOT EXISTS "fileHash" TEXT;
ALTER TABLE "ExpenseClaimLine" ADD COLUMN IF NOT EXISTS "mimeType" TEXT;
ALTER TABLE "ExpenseClaimLine" ADD COLUMN IF NOT EXISTS "receiptOcrJson" JSONB;

-- ── ExpensePolicy field additions (fold into the policy engine) ─────────────────
ALTER TABLE "ExpensePolicy" ADD COLUMN IF NOT EXISTS "dailyCap" DECIMAL(15,2);
ALTER TABLE "ExpensePolicy" ADD COLUMN IF NOT EXISTS "enforcement" "PolicyEnforcement" NOT NULL DEFAULT 'FLAG';

-- ── CityTier ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "CityTier" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "tier" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "stateCode" TEXT,
  "countryCode" CHAR(2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "CityTier_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CityTier_businessId_countryCode_city_key" ON "CityTier"("businessId", "countryCode", "city");
CREATE INDEX IF NOT EXISTS "CityTier_businessId_tier_idx" ON "CityTier"("businessId", "tier");

-- ── TravelPolicy ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TravelPolicy" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "entityId" TEXT,
  "name" TEXT NOT NULL,
  "countryCode" CHAR(2) NOT NULL,
  "currencyCode" CHAR(3) NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "effectiveFrom" DATE NOT NULL,
  "defaultTier" TEXT NOT NULL DEFAULT 'TIER_3',
  "enforcement" "PolicyEnforcement" NOT NULL DEFAULT 'FLAG',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "TravelPolicy_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TravelPolicy_businessId_isActive_idx" ON "TravelPolicy"("businessId", "isActive");
CREATE INDEX IF NOT EXISTS "TravelPolicy_businessId_entityId_countryCode_idx" ON "TravelPolicy"("businessId", "entityId", "countryCode");

-- ── TravelPerDiemRule ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TravelPerDiemRule" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "durationBand" "PerDiemBand" NOT NULL,
  "gradeRank" INTEGER,
  "cityTier" TEXT,
  "foodCap" DECIMAL(15,2) NOT NULL,
  "incidentalCap" DECIMAL(15,2) NOT NULL,
  CONSTRAINT "TravelPerDiemRule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TravelPerDiemRule_businessId_policyId_idx" ON "TravelPerDiemRule"("businessId", "policyId");

-- ── TravelHotelRule ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TravelHotelRule" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "gradeRank" INTEGER NOT NULL,
  "cityTier" TEXT NOT NULL,
  "nightlyCap" DECIMAL(15,2) NOT NULL,
  CONSTRAINT "TravelHotelRule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TravelHotelRule_policyId_gradeRank_cityTier_key" ON "TravelHotelRule"("policyId", "gradeRank", "cityTier");
CREATE INDEX IF NOT EXISTS "TravelHotelRule_businessId_policyId_idx" ON "TravelHotelRule"("businessId", "policyId");

-- ── TravelTransportRule ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TravelTransportRule" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "mode" "TransportMode" NOT NULL,
  "gradeRank" INTEGER,
  "allowed" BOOLEAN NOT NULL DEFAULT true,
  "perKmRate" DECIMAL(8,2),
  "fareCap" DECIMAL(15,2),
  "travelClass" TEXT,
  "minJourneyHrs" INTEGER,
  "conditionJson" JSONB,
  CONSTRAINT "TravelTransportRule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TravelTransportRule_policyId_mode_gradeRank_key" ON "TravelTransportRule"("policyId", "mode", "gradeRank");
CREATE INDEX IF NOT EXISTS "TravelTransportRule_businessId_policyId_idx" ON "TravelTransportRule"("businessId", "policyId");

-- ── TravelRequest ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TravelRequest" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "travelNumber" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "isOutdoorDuty" BOOLEAN NOT NULL DEFAULT false,
  "originCity" TEXT,
  "destCity" TEXT,
  "destTier" TEXT,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  "durationHours" INTEGER,
  "estimateJson" JSONB,
  "advanceAmount" DECIMAL(15,2),
  "currencyCode" CHAR(3) NOT NULL,
  "policyId" TEXT,
  "status" "TravelStatus" NOT NULL DEFAULT 'DRAFT',
  "approvalRequestId" TEXT,
  "submittedAt" TIMESTAMP(3),
  "decidedAt" TIMESTAMP(3),
  "decidedBy" TEXT,
  "rejectReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "TravelRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TravelRequest_businessId_travelNumber_key" ON "TravelRequest"("businessId", "travelNumber");
CREATE INDEX IF NOT EXISTS "TravelRequest_businessId_employeeId_idx" ON "TravelRequest"("businessId", "employeeId");
CREATE INDEX IF NOT EXISTS "TravelRequest_businessId_status_idx" ON "TravelRequest"("businessId", "status");

-- ── Indexes on the new FK columns of the existing claim tables ───────────────────
CREATE INDEX IF NOT EXISTS "ExpenseClaim_businessId_travelRequestId_idx" ON "ExpenseClaim"("businessId", "travelRequestId");
CREATE INDEX IF NOT EXISTS "ExpenseClaimLine_businessId_categoryId_idx" ON "ExpenseClaimLine"("businessId", "categoryId");

-- ── Foreign keys (guarded — added only if absent) ────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_travelRequestId_fkey"
    FOREIGN KEY ("travelRequestId") REFERENCES "TravelRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "ExpenseClaimLine" ADD CONSTRAINT "ExpenseClaimLine_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "CityTier" ADD CONSTRAINT "CityTier_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "TravelPolicy" ADD CONSTRAINT "TravelPolicy_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "TravelPerDiemRule" ADD CONSTRAINT "TravelPerDiemRule_policyId_fkey"
    FOREIGN KEY ("policyId") REFERENCES "TravelPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "TravelHotelRule" ADD CONSTRAINT "TravelHotelRule_policyId_fkey"
    FOREIGN KEY ("policyId") REFERENCES "TravelPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "TravelTransportRule" ADD CONSTRAINT "TravelTransportRule_policyId_fkey"
    FOREIGN KEY ("policyId") REFERENCES "TravelPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "TravelRequest" ADD CONSTRAINT "TravelRequest_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "TravelRequest" ADD CONSTRAINT "TravelRequest_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "TravelRequest" ADD CONSTRAINT "TravelRequest_policyId_fkey"
    FOREIGN KEY ("policyId") REFERENCES "TravelPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
