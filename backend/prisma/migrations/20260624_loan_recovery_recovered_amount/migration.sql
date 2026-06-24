-- Loan→payroll recovery reconciliation — money-exactness fix.
-- ADDITIVE only: one nullable column on the EXISTING LoanInstallment table plus a
-- supporting index. No NOT NULL on an existing column, no backfill — safe on a live
-- tenant. IF NOT EXISTS guards keep it idempotent for db-push parity + re-runs.
--
-- recoveredAmount records the paise ACTUALLY credited to the loan for this
-- installment by its owning pay run. It is the single reconciliation figure shared by
-- the LOAN_REPAYMENT debit, the loan credit and the Loan.amountRepaid increment; a
-- net-capped PARTIAL recovery stores < amount and the installment stays PENDING so its
-- remainder carries forward, while unwind reverses exactly this figure (never the
-- nominal `amount`, which previously drifted totals on every reopen).
ALTER TABLE "LoanInstallment" ADD COLUMN IF NOT EXISTS "recoveredAmount" DECIMAL(15,2);

-- Unwind / per-run selection scan installments by (businessId, payRunId); index it.
CREATE INDEX IF NOT EXISTS "LoanInstallment_businessId_payRunId_idx"
  ON "LoanInstallment" ("businessId", "payRunId");
