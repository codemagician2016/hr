-- Feature 30 comp-off ledger-correctness fixes (cycle4 review).
-- ADDITIVE + idempotent (IF NOT EXISTS / DROP IF EXISTS), safe to re-run.
--
-- Finding #2/#3: re-key earn idempotency off the runtime-derived `sourceKind` onto
--   the IMMUTABLE `attendanceId`. A holiday/weekly-off classification flip between
--   runner passes can no longer mint a second credit for the same worked day.
-- Finding #5/#1: persist which lots each COMP_OFF APPLICATION debited so withdraw
--   re-credits EXACTLY those lots (CompOffConsumption).

-- ── Finding #2: swap the earn idempotency unique index ───────────────────────────
-- Drop the old (sourceDate, sourceKind) key — sourceKind is runtime-derived and must
-- never be part of the idempotency key.
DROP INDEX IF EXISTS "CompOffCredit_businessId_employeeId_sourceDate_sourceKind_key";

-- New key on the immutable attendance row. attendanceId is NULL for HR_GRANT; Postgres
-- treats NULLs as distinct, so manual grants are excepted (multiple per date allowed).
CREATE UNIQUE INDEX IF NOT EXISTS "CompOffCredit_businessId_employeeId_attendanceId_key"
    ON "CompOffCredit"("businessId", "employeeId", "attendanceId");

-- ── Finding #5: per-application lot allocation ───────────────────────────────────
CREATE TABLE IF NOT EXISTS "CompOffConsumption" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "leaveTransactionId" TEXT NOT NULL,
    "compOffCreditId" TEXT NOT NULL,
    "units" DECIMAL(6,4) NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompOffConsumption_pkey" PRIMARY KEY ("id")
);

-- One allocation row per (application, lot).
CREATE UNIQUE INDEX IF NOT EXISTS "CompOffConsumption_leaveTransactionId_compOffCreditId_key"
    ON "CompOffConsumption"("leaveTransactionId", "compOffCreditId");

CREATE INDEX IF NOT EXISTS "CompOffConsumption_businessId_compOffCreditId_idx"
    ON "CompOffConsumption"("businessId", "compOffCreditId");

CREATE INDEX IF NOT EXISTS "CompOffConsumption_businessId_leaveTransactionId_idx"
    ON "CompOffConsumption"("businessId", "leaveTransactionId");

-- FKs — tenant + ledger + lot cascade (a deleted application/credit drops its rows).
DO $$ BEGIN
  ALTER TABLE "CompOffConsumption"
    ADD CONSTRAINT "CompOffConsumption_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CompOffConsumption"
    ADD CONSTRAINT "CompOffConsumption_leaveTransactionId_fkey"
    FOREIGN KEY ("leaveTransactionId") REFERENCES "LeaveTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CompOffConsumption"
    ADD CONSTRAINT "CompOffConsumption_compOffCreditId_fkey"
    FOREIGN KEY ("compOffCreditId") REFERENCES "CompOffCredit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
