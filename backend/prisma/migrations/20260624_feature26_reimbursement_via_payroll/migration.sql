-- Feature 26 — Reimbursement paid via payroll.
-- ADDITIVE only: one new enum, two nullable/defaulted columns on the EXISTING
-- ExpenseClaim table, one defaulted column on Entity, plus a supporting selection
-- index. No NOT NULL on a pre-existing column without a default, no destructive
-- change, no backfill — safe on a live tenant. IF NOT EXISTS / DO-block guards keep
-- it idempotent for db-push parity + re-runs.
--
-- The payroll-payout pass (controllers/reimbursementPayout.js) MIRRORS the loan
-- recovery pass as a POSITIVE payment: it selects APPROVED + PAY_VIA_PAYROLL claims,
-- the engine emits a non-taxable CATEGORY.REIMBURSEMENT line that adds to net AFTER
-- statutory deductions, and on persist the claim is stamped REIMBURSED + payRunId +
-- paidViaPayrollAmount (reversed exactly by unwindForRun on recompute/reopen/cancel).

-- CreateEnum — the per-claim channel choice (tenant default lives on Entity).
DO $$ BEGIN
  CREATE TYPE "ReimbursementPayoutChannel" AS ENUM ('PAY_SEPARATELY', 'PAY_VIA_PAYROLL');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ExpenseClaim — payoutChannel (defaulted) + paidViaPayrollAmount (the single
-- reconciliation figure; NULL = never paid via payroll). payRunId already exists and
-- doubles as the owning-run stamp.
ALTER TABLE "ExpenseClaim"
  ADD COLUMN IF NOT EXISTS "payoutChannel" "ReimbursementPayoutChannel" NOT NULL DEFAULT 'PAY_SEPARATELY',
  ADD COLUMN IF NOT EXISTS "paidViaPayrollAmount" DECIMAL(15,2);

-- Entity — the tenant/entity DEFAULT channel applied to a new claim at submit.
ALTER TABLE "Entity"
  ADD COLUMN IF NOT EXISTS "reimbursementDefaultChannel" "ReimbursementPayoutChannel" NOT NULL DEFAULT 'PAY_SEPARATELY';

-- The pay pass scans candidate claims by (businessId, payoutChannel, status); index it.
CREATE INDEX IF NOT EXISTS "ExpenseClaim_businessId_payoutChannel_status_idx"
  ON "ExpenseClaim" ("businessId", "payoutChannel", "status");
