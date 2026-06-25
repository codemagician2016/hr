-- Feature 7 — payroll pre-run anomaly ACKNOWLEDGE / override-before-approve gate.
-- ADDITIVE only: ONE new table (AnomalyAcknowledgement). No existing column is
-- touched, no NOT NULL without a default on a pre-existing table, no backfill, no
-- destructive change — safe on a live tenant. Hand-authored to be idempotent
-- (IF NOT EXISTS guards) so it applies cleanly to a clean `migrate deploy` AND to
-- the isolated hr_test schema (bootstrapped via `prisma db push`) on re-runs.

-- The explicit, audited human override of a pre-run BLOCKER: a checker
-- (canApprovePayroll) acknowledges a specific (code[, employeeId]) finding WITH a
-- reason so approveRun can proceed past the blocker gate. Append-only provenance.
CREATE TABLE IF NOT EXISTS "AnomalyAcknowledgement" (
  "id"             TEXT NOT NULL,
  "businessId"     TEXT NOT NULL,
  "payRunId"       TEXT NOT NULL,
  "code"           TEXT NOT NULL,
  "employeeId"     TEXT,
  "reason"         TEXT NOT NULL,
  "acknowledgedBy" TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnomalyAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- One LIVE ack per (run, code, employee). A NULL employeeId (run-scoped blocker
-- like RECONCILIATION_MISMATCH) collapses to a single ack per code per run.
CREATE UNIQUE INDEX IF NOT EXISTS "AnomalyAcknowledgement_payRunId_code_employeeId_key"
  ON "AnomalyAcknowledgement" ("payRunId", "code", "employeeId");

CREATE INDEX IF NOT EXISTS "AnomalyAcknowledgement_businessId_payRunId_idx"
  ON "AnomalyAcknowledgement" ("businessId", "payRunId");

-- FKs (guarded so a re-run / db-push'd hr_test does not error on duplicates).
DO $$ BEGIN
  ALTER TABLE "AnomalyAcknowledgement"
    ADD CONSTRAINT "AnomalyAcknowledgement_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "AnomalyAcknowledgement"
    ADD CONSTRAINT "AnomalyAcknowledgement_payRunId_fkey"
    FOREIGN KEY ("payRunId") REFERENCES "PayRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
