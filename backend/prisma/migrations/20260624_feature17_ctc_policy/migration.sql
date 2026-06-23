-- Feature 17 — CTC Policy + Statement builder + Onboard-by-CTC.
-- ADDITIVE only: two new tables (CtcPolicy, CtcPolicyLine) for the friendly,
-- CTC-AGNOSTIC salary-template builder. No changes to existing tables/columns, no
-- data backfill, no NOT NULL on an existing column — safe to apply on a live tenant
-- (mirrors the additive migrations of feature10/13/19). IF NOT EXISTS guards keep
-- it idempotent against a schema that was previously `db push`-ed.
--
-- A CtcPolicy holds RULES (percent/flat/balancing/statutory) for how to split a CTC,
-- never a person's resolved amounts; it compiles to SalaryComponentLine[] on demand
-- (→ deriveBreakup). The onboard revision it ultimately produces is an ordinary
-- CompensationRevision(HIRE, EFFECTIVE) — indistinguishable downstream from an ATS
-- hire. countryCode is server-stamped = the tenant country (single-country invariant).

-- CreateTable
CREATE TABLE IF NOT EXISTS "CtcPolicy" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "currencyCode" CHAR(3) NOT NULL,
    "basis" "StructureBasis" NOT NULL DEFAULT 'CTC',
    "esiApplicable" BOOLEAN NOT NULL DEFAULT false,
    "capPfAtCeiling" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CtcPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CtcPolicyLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "calcMethod" "ComponentCalcMethod" NOT NULL,
    "pct" DECIMAL(8,4),
    "flatMonthly" DECIMAL(15,2),
    "baseCode" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CtcPolicyLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CtcPolicy_businessId_code_key" ON "CtcPolicy"("businessId", "code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CtcPolicy_businessId_entityId_isActive_idx" ON "CtcPolicy"("businessId", "entityId", "isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CtcPolicyLine_businessId_policyId_idx" ON "CtcPolicyLine"("businessId", "policyId");

-- AddForeignKey
ALTER TABLE "CtcPolicy" ADD CONSTRAINT "CtcPolicy_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CtcPolicyLine" ADD CONSTRAINT "CtcPolicyLine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CtcPolicyLine" ADD CONSTRAINT "CtcPolicyLine_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "CtcPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CtcPolicyLine" ADD CONSTRAINT "CtcPolicyLine_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "SalaryComponent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
