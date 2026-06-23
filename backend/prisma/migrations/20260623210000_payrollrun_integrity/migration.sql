-- Payroll-run integrity hardening — ADDITIVE ONLY. No rename/drop; historical
-- pay runs replay identically. Hand-authored + idempotent (IF NOT EXISTS) so it
-- applies cleanly to a clean migrate-deploy AND to the isolated hr_test schema
-- (bootstrapped via `prisma db push`).
--
-- 1. PayRunLine.pfWagesBase / epsWagesBase / edliWagesBase — the ACTUAL statutory
--    wage base the engine computed each PF account on, persisted so IN filing
--    (ECR/24Q) reads the real wage straight through instead of reconstructing it
--    by dividing the contribution by a hardcoded 0.12 (which corrupts paise once
--    the wage is capped / on full wage / VPF-adjusted).
-- 2. PayRunLine.varianceJson — period-over-period variance findings kept in a
--    SEPARATE column from errorJson (engine anomalies). The two writers (compute
--    vs computeVariance) no longer clobber each other's BLOCKERs on one column;
--    recountBlockers sums BOTH so no BLOCKER source is lost to call ordering.

ALTER TABLE "PayRunLine" ADD COLUMN IF NOT EXISTS "pfWagesBase"   DECIMAL(15,2);
ALTER TABLE "PayRunLine" ADD COLUMN IF NOT EXISTS "epsWagesBase"  DECIMAL(15,2);
ALTER TABLE "PayRunLine" ADD COLUMN IF NOT EXISTS "edliWagesBase" DECIMAL(15,2);
ALTER TABLE "PayRunLine" ADD COLUMN IF NOT EXISTS "varianceJson"  JSONB;
