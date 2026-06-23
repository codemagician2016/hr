-- Feature 4 (Offboarding/FnF) — additive snapshot + SoD-initiator columns on SeparationCase.
-- Additive only (no destructive change). Hand-authored to be idempotent so it applies
-- cleanly to the isolated hr_test schema (bootstrapped via `prisma db push`) as well as
-- a clean migrate-deploy: each ADD COLUMN uses IF NOT EXISTS.

-- fnfSnapshotJson: the FULL computeFnf result (payRunInput earnings/deductions lines +
-- grossMinor/totalDeductionsMinor/netMinor + breakdown). The PayRun(type=FNF) is minted
-- DIRECTLY from this on approve, so totalGross − totalDeductions === totalNet always and
-- every component (gratuity, encashment, NZ payout, unpaid salary, notice pay-in-lieu /
-- recovery, loan, asset, statutory) is reflected on the run.
ALTER TABLE "SeparationCase" ADD COLUMN IF NOT EXISTS "fnfSnapshotJson" JSONB;

-- initiatedByUserId: the SoD anchor persisted in the SAME tx as the case for BOTH the HR
-- initiate path and the ESS self-resign path. approve-fnf FAILS CLOSED (403) when it is
-- null/unknown OR equals the approver (so a self-resign with a null initiator can no
-- longer be self-approved).
ALTER TABLE "SeparationCase" ADD COLUMN IF NOT EXISTS "initiatedByUserId" TEXT;
