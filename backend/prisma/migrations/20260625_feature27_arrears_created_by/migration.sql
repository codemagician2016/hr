-- Auto-arrears (Feature 27) — review fixes #2 + #6.
-- ADDITIVE / index-swap only. Safe on a live tenant; IF [NOT] EXISTS guards keep it
-- idempotent for db-push parity + re-runs.

-- Finding #6 — record the cycle CREATOR so approveArrearCycle can enforce
-- approver ≠ creator (in addition to approver ≠ computer). Nullable, no backfill.
ALTER TABLE "ArrearCycle" ADD COLUMN IF NOT EXISTS "createdBy" TEXT;

-- Finding #2 — the exactly-once-per-revision guard must NOT strand a CANCELLED
-- (soft-deleted) cycle. Replace the FULL unique index with a PARTIAL unique index that
-- applies only to LIVE rows (deletedAt IS NULL), so a cancelled cycle can be regenerated
-- for the same revision (detectArrearCycles already excludes soft-deleted cycles).
DROP INDEX IF EXISTS "hr_test"."ArrearCycle_businessId_compensationRevisionId_key";
DROP INDEX IF EXISTS "ArrearCycle_businessId_compensationRevisionId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ArrearCycle_businessId_compensationRevisionId_live_key"
  ON "ArrearCycle" ("businessId", "compensationRevisionId")
  WHERE "deletedAt" IS NULL;
-- A plain (non-unique) supporting index for lookups by revision (matches schema @@index).
CREATE INDEX IF NOT EXISTS "ArrearCycle_businessId_compensationRevisionId_idx"
  ON "ArrearCycle" ("businessId", "compensationRevisionId");
