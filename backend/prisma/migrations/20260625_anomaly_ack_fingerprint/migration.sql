-- Anomaly-ack gate hardening — bind each ack to the EXACT finding it overrides
-- (HIGH-1) and dedup the run-scoped (NULL-employee) ack (LOW-5).
-- ADDITIVE only: ONE new nullable column + ONE new partial unique index on the
-- EXISTING AnomalyAcknowledgement table. No NOT NULL without a default, no
-- backfill, no destructive change — safe on a live tenant. IF NOT EXISTS / DO-block
-- guards keep it idempotent for `migrate deploy`, db-push parity (hr_test) + re-runs.

-- HIGH-1: finding-CONTENT fingerprint captured at ack time. NULL on legacy rows;
-- legacy acks keep matching by (code, employeeId) only (back-compatible). A fresh
-- ack stamps the hash of {code, employeeId, observed, baseline, deltaMinor} + the
-- run's totalsHash, so a recompute that changes the blocker's numbers invalidates
-- the prior ack (countUnacknowledgedBlockers refuses to credit a mismatching hash).
ALTER TABLE "AnomalyAcknowledgement" ADD COLUMN IF NOT EXISTS "fingerprint" TEXT;

-- LOW-5: Postgres treats NULLs as DISTINCT in the multi-column UNIQUE
-- (payRunId, code, employeeId), so the run-scoped (employeeId IS NULL) rows are NOT
-- deduped by it — duplicate run-scoped acks for the same code could accumulate. This
-- partial unique index enforces ONE run-scoped ack per (payRunId, code). (The service
-- also branches to findFirst+update on the NULL path, so this is belt-and-braces.)
CREATE UNIQUE INDEX IF NOT EXISTS "AnomalyAcknowledgement_payRunId_code_runscoped_key"
  ON "AnomalyAcknowledgement" ("payRunId", "code")
  WHERE "employeeId" IS NULL;
