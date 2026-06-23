-- Feature 7 (Payroll Run experience) — ADDITIVE ONLY. No rename/drop; historical
-- pay runs replay identically. Hand-authored + idempotent (IF NOT EXISTS / DO
-- blocks) so it applies cleanly to a clean migrate-deploy AND to the isolated
-- hr_test schema (bootstrapped via `prisma db push`).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. New enum (PayRunInputKind). PayRunStatus already carries the reserved
--    REVIEW/LOCKED members — no enum change for the review gate.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "PayRunInputKind" AS ENUM ('OTE','OTD','ARREAR','REIMBURSEMENT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. PayRun — review-gate sub-state flags + close/totals fingerprint + run-level
--    variance roll-up (all nullable/additive). filedAt records FILED time (the
--    state machine sets it; column previously implicit via status only).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "PayRun" ADD COLUMN IF NOT EXISTS "submittedAt"    TIMESTAMP(3);
ALTER TABLE "PayRun" ADD COLUMN IF NOT EXISTS "submittedBy"    TEXT;
ALTER TABLE "PayRun" ADD COLUMN IF NOT EXISTS "reviewedBy"     TEXT;
ALTER TABLE "PayRun" ADD COLUMN IF NOT EXISTS "reviewedAt"     TIMESTAMP(3);
ALTER TABLE "PayRun" ADD COLUMN IF NOT EXISTS "sendBackReason" TEXT;
ALTER TABLE "PayRun" ADD COLUMN IF NOT EXISTS "closedAt"       TIMESTAMP(3);
ALTER TABLE "PayRun" ADD COLUMN IF NOT EXISTS "totalsHash"     TEXT;
ALTER TABLE "PayRun" ADD COLUMN IF NOT EXISTS "varianceReport" JSONB;
ALTER TABLE "PayRun" ADD COLUMN IF NOT EXISTS "filedAt"        TIMESTAMP(3);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. PayRunInputItem — one-time / ad-hoc run inputs.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PayRunInputItem" (
  "id"            TEXT NOT NULL,
  "businessId"    TEXT NOT NULL,
  "payRunId"      TEXT NOT NULL,
  "employeeId"    TEXT NOT NULL,
  "kind"          "PayRunInputKind" NOT NULL,
  "componentCode" TEXT,
  "amountMinor"   BIGINT NOT NULL,
  "sourcePeriod"  TEXT,
  "taxable"       BOOLEAN NOT NULL DEFAULT true,
  "note"          TEXT,
  "createdBy"     TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version"       INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "PayRunInputItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PayRunInputItem_businessId_payRunId_employeeId_idx"
  ON "PayRunInputItem" ("businessId", "payRunId", "employeeId");

DO $$ BEGIN
  ALTER TABLE "PayRunInputItem"
    ADD CONSTRAINT "PayRunInputItem_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "PayRunInputItem"
    ADD CONSTRAINT "PayRunInputItem_payRunId_fkey"
    FOREIGN KEY ("payRunId") REFERENCES "PayRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. VarianceThreshold — per-tenant variance tolerance config (one per business).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "VarianceThreshold" (
  "id"         TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "config"     JSONB NOT NULL,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VarianceThreshold_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "VarianceThreshold_businessId_key"
  ON "VarianceThreshold" ("businessId");

DO $$ BEGIN
  ALTER TABLE "VarianceThreshold"
    ADD CONSTRAINT "VarianceThreshold_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
