-- Feature 25 — Flexible Benefit Plan (FBP / Flexi Basket), India-only, OLD-regime
-- tax-optimised allowances carved from CTC. ADDITIVE ONLY: four new tables + three
-- new enums + a window `purpose` discriminator + six FBP_* values on the existing
-- ProofClaimType enum. The WINDOW is reused (InvestmentDeclarationWindow +
-- purpose) and PROOFS are reused (InvestmentProof + FBP_* claim types) — no fork.

-- ── Extend the existing ProofClaimType enum with the bill-backed FBP heads ──────
ALTER TYPE "ProofClaimType" ADD VALUE IF NOT EXISTS 'FBP_LTA';
ALTER TYPE "ProofClaimType" ADD VALUE IF NOT EXISTS 'FBP_FUEL';
ALTER TYPE "ProofClaimType" ADD VALUE IF NOT EXISTS 'FBP_TELEPHONE';
ALTER TYPE "ProofClaimType" ADD VALUE IF NOT EXISTS 'FBP_BOOKS';
ALTER TYPE "ProofClaimType" ADD VALUE IF NOT EXISTS 'FBP_PROF_DEV';
ALTER TYPE "ProofClaimType" ADD VALUE IF NOT EXISTS 'FBP_UNIFORM';

-- ── New enums ───────────────────────────────────────────────────────────────────
CREATE TYPE "DeclWindowPurpose" AS ENUM ('INVESTMENT_PROOF', 'FBP_ALLOCATION');
CREATE TYPE "FbpHeadType" AS ENUM ('LTA', 'MEAL_CARD', 'FUEL_CAR', 'TELEPHONE_INTERNET', 'BOOKS_PERIODICALS', 'PROF_DEV', 'UNIFORM', 'OTHER');
CREATE TYPE "FbpPayCadence" AS ENUM ('MONTHLY', 'ON_CLAIM');
CREATE TYPE "FbpAllocationStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'LOCKED', 'SUPERSEDED');

-- ── Window: add purpose discriminator; repoint the unique key to include it ──────
-- Note: Postgres truncates the F20 generated unique-index name to 63 chars
-- ("..._countr_key"); we drop that and recreate the 4-column unique key. We keep
-- the F20 truncated index name so existing rows + the @@unique stay byte-identical.
ALTER TABLE "InvestmentDeclarationWindow" ADD COLUMN "purpose" "DeclWindowPurpose" NOT NULL DEFAULT 'INVESTMENT_PROOF';
ALTER TABLE "InvestmentDeclarationWindow" DROP CONSTRAINT IF EXISTS "InvestmentDeclarationWindow_businessId_financialYear_countr_key";
DROP INDEX IF EXISTS "InvestmentDeclarationWindow_businessId_financialYear_countr_key";
CREATE UNIQUE INDEX "InvestmentDeclarationWindow_businessId_financialYear_countr_key" ON "InvestmentDeclarationWindow"("businessId", "financialYear", "countryCode", "purpose");

-- ── FbpPlan ───────────────────────────────────────────────────────────────────
CREATE TABLE "FbpPlan" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "countryCode" CHAR(2) NOT NULL DEFAULT 'IN',
    "financialYear" VARCHAR(7) NOT NULL,
    "envelopeComponentId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FbpPlan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FbpPlan_businessId_code_key" ON "FbpPlan"("businessId", "code");
CREATE INDEX "FbpPlan_businessId_entityId_financialYear_isActive_idx" ON "FbpPlan"("businessId", "entityId", "financialYear", "isActive");

-- ── FbpPlanHead ──────────────────────────────────────────────────────────────
CREATE TABLE "FbpPlanHead" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "headType" "FbpHeadType" NOT NULL,
    "label" TEXT NOT NULL,
    "taxSection" VARCHAR(16),
    "annualCapRupees" DECIMAL(15,2),
    "monthlyCapRupees" DECIMAL(15,2),
    "minAllocRupees" DECIMAL(15,2),
    "exemptOldRegimeOnly" BOOLEAN NOT NULL DEFAULT true,
    "proofRequired" BOOLEAN NOT NULL DEFAULT true,
    "payCadence" "FbpPayCadence" NOT NULL DEFAULT 'MONTHLY',
    "claimType" "ProofClaimType",
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FbpPlanHead_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FbpPlanHead_businessId_planId_sortOrder_idx" ON "FbpPlanHead"("businessId", "planId", "sortOrder");

-- ── FbpAllocation ────────────────────────────────────────────────────────────
CREATE TABLE "FbpAllocation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "windowId" TEXT,
    "financialYear" VARCHAR(7) NOT NULL,
    "envelopeAnnualRupees" DECIMAL(15,2) NOT NULL,
    "status" "FbpAllocationStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FbpAllocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FbpAllocation_businessId_employeeId_financialYear_version_key" ON "FbpAllocation"("businessId", "employeeId", "financialYear", "version");
CREATE INDEX "FbpAllocation_businessId_employeeId_financialYear_status_idx" ON "FbpAllocation"("businessId", "employeeId", "financialYear", "status");

-- ── FbpAllocationLine ────────────────────────────────────────────────────────
CREATE TABLE "FbpAllocationLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "headId" TEXT NOT NULL,
    "annualAmountRupees" DECIMAL(15,2) NOT NULL,
    "verifiedSpendRupees" DECIMAL(15,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FbpAllocationLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FbpAllocationLine_businessId_allocationId_idx" ON "FbpAllocationLine"("businessId", "allocationId");
CREATE INDEX "FbpAllocationLine_businessId_headId_idx" ON "FbpAllocationLine"("businessId", "headId");

-- ── Foreign keys ─────────────────────────────────────────────────────────────
ALTER TABLE "FbpPlan" ADD CONSTRAINT "FbpPlan_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbpPlan" ADD CONSTRAINT "FbpPlan_envelopeComponentId_fkey" FOREIGN KEY ("envelopeComponentId") REFERENCES "SalaryComponent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FbpPlanHead" ADD CONSTRAINT "FbpPlanHead_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FbpPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbpPlanHead" ADD CONSTRAINT "FbpPlanHead_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "SalaryComponent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FbpAllocation" ADD CONSTRAINT "FbpAllocation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbpAllocation" ADD CONSTRAINT "FbpAllocation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbpAllocation" ADD CONSTRAINT "FbpAllocation_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FbpPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FbpAllocation" ADD CONSTRAINT "FbpAllocation_windowId_fkey" FOREIGN KEY ("windowId") REFERENCES "InvestmentDeclarationWindow"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FbpAllocationLine" ADD CONSTRAINT "FbpAllocationLine_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "FbpAllocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbpAllocationLine" ADD CONSTRAINT "FbpAllocationLine_headId_fkey" FOREIGN KEY ("headId") REFERENCES "FbpPlanHead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
