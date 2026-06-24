-- Feature 30 — Comp-off (compensatory off) lifecycle.
-- ADDITIVE only: two new enums, one new table (CompOffCredit), one nullable JSON
-- column on the EXISTING LeavePolicy table. No NOT NULL on a pre-existing column
-- without a default, no destructive change, no backfill — safe on a live tenant.
-- IF NOT EXISTS / DO-block guards keep it idempotent for db-push parity + re-runs.
--
-- A comp-off credit is the per-credit expiry "lot" the flat aggregate LeaveBalance
-- cannot express. The aggregate COMP_OFF LeaveBalance.closing is kept in lockstep
-- (== Σ remaining over ACTIVE lots) so every existing balance/ledger/reconcile/FnF
-- path keeps working unchanged. `remaining` is DERIVED (quantity − consumed).

-- CreateEnum — provenance of a credit.
DO $$ BEGIN
  CREATE TYPE "CompOffSourceKind" AS ENUM ('WEEKLY_OFF', 'HOLIDAY', 'EXTRA_HOURS', 'HR_GRANT');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateEnum — lot lifecycle status.
DO $$ BEGIN
  CREATE TYPE "CompOffCreditStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXHAUSTED', 'EXPIRED', 'VOIDED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- AlterEnum — comp-off earn approval routes through its own WorkflowModule (so its
-- approval-engine consumer never collides with the LEAVE consumer's APPLICATION
-- handler). Additive enum value; ADD VALUE IF NOT EXISTS is idempotent.
ALTER TYPE "WorkflowModule" ADD VALUE IF NOT EXISTS 'COMP_OFF';

-- AlterTable — comp-off policy knobs (only meaningful for a COMP_OFF-type policy).
ALTER TABLE "LeavePolicy" ADD COLUMN IF NOT EXISTS "compOffConfig" JSONB;

-- CreateTable — the expiry lot.
CREATE TABLE IF NOT EXISTS "CompOffCredit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "sourceDate" DATE NOT NULL,
    "sourceKind" "CompOffSourceKind" NOT NULL,
    "attendanceId" TEXT,
    "quantity" DECIMAL(6,4) NOT NULL,
    "consumed" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "earnedOn" DATE NOT NULL,
    "expiresOn" DATE NOT NULL,
    "status" "CompOffCreditStatus" NOT NULL DEFAULT 'PENDING',
    "approvalRequestId" TEXT,
    "grantedBy" TEXT,
    "reason" TEXT,
    "creditTxnId" TEXT,
    "leaveBalanceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CompOffCredit_pkey" PRIMARY KEY ("id")
);

-- One credit per worked rest-day (idempotent earn).
CREATE UNIQUE INDEX IF NOT EXISTS "CompOffCredit_businessId_employeeId_sourceDate_sourceKind_key"
    ON "CompOffCredit"("businessId", "employeeId", "sourceDate", "sourceKind");

-- FIFO consume + ESS list.
CREATE INDEX IF NOT EXISTS "CompOffCredit_businessId_employeeId_status_expiresOn_idx"
    ON "CompOffCredit"("businessId", "employeeId", "status", "expiresOn");

-- Expiry-runner scan.
CREATE INDEX IF NOT EXISTS "CompOffCredit_businessId_status_expiresOn_idx"
    ON "CompOffCredit"("businessId", "status", "expiresOn");

-- AddForeignKey — tenant + employee cascade (mirrors LeaveBalance/LeaveTransaction).
DO $$ BEGIN
  ALTER TABLE "CompOffCredit"
    ADD CONSTRAINT "CompOffCredit_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "CompOffCredit"
    ADD CONSTRAINT "CompOffCredit_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
