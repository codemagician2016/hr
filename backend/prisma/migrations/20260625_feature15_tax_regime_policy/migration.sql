-- Feature 15/25 — Income-tax REGIME ELECTION policy (employer default + window + lock).
-- This migration is PURELY ADDITIVE: one new table (TaxRegimePolicy — the per-FY
-- employer default regime + election window + global lock) and one new NULLABLE
-- column on StatutoryProfile (regimeLockedAt — the per-employee election-lock signal).
-- NO NOT NULL on an existing column, NO backfill, NO data migration — safe on a live
-- tenant (mirrors the additive migrations of feature20/25/32). IF NOT EXISTS / DO-block
-- guards keep it idempotent for db-push parity + re-runs. INTaxRegime enum already
-- exists (StatutoryProfile.taxRegime) — reused, not redefined.

-- ── StatutoryProfile.regimeLockedAt — per-employee election lock (nullable) ────
ALTER TABLE "StatutoryProfile" ADD COLUMN IF NOT EXISTS "regimeLockedAt" TIMESTAMP(3);

-- ── TaxRegimePolicy — the per-FY employer regime stance ───────────────────────
CREATE TABLE IF NOT EXISTS "TaxRegimePolicy" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "fy" VARCHAR(7) NOT NULL,
    "defaultRegime" "INTaxRegime" NOT NULL DEFAULT 'NEW',
    "electionOpenFrom" TIMESTAMP(3),
    "electionLockDate" TIMESTAMP(3),
    "lockedGlobally" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TaxRegimePolicy_pkey" PRIMARY KEY ("id")
);

-- One policy per tenant per FY.
CREATE UNIQUE INDEX IF NOT EXISTS "TaxRegimePolicy_businessId_fy_key" ON "TaxRegimePolicy"("businessId", "fy");
CREATE INDEX IF NOT EXISTS "TaxRegimePolicy_businessId_idx" ON "TaxRegimePolicy"("businessId");

-- Tenant FK (cascade with the rest of the tenant's data). Guarded so re-runs are safe.
DO $$ BEGIN
  ALTER TABLE "TaxRegimePolicy"
    ADD CONSTRAINT "TaxRegimePolicy_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
