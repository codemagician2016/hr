-- Feature 31 — IN-SERVICE leave encashment (distinct from F&F exit encashment).
-- ADDITIVE only: two new enums, in-service encashment knobs on the EXISTING
-- LeavePolicy table (all with safe defaults), one new WorkflowModule enum value,
-- and one new table (LeaveEncashmentRequest). No NOT NULL on a pre-existing column
-- without a default, no destructive change, no backfill — safe on a live tenant.
-- IF NOT EXISTS / DO-block guards keep it idempotent for db-push parity + re-runs.
--
-- The leave ledger already carries the ENCASHMENT primitive (LeaveTxnType.ENCASHMENT,
-- LeaveBalance.encashed, the closing identity subtracts it) so the balance debit is a
-- solved problem; this migration only adds the request entity + policy that trigger it.

-- CreateEnum — the per-day money basis (BASIC_DA_26 reuses fnf.perDay26).
DO $$ BEGIN
  CREATE TYPE "EncashmentBasis" AS ENUM ('BASIC_DA_26', 'BASIC_30', 'GROSS_30');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateEnum — request lifecycle (PENDING hold → APPROVED debit → PAID stamp).
DO $$ BEGIN
  CREATE TYPE "EncashmentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'PAID');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- AlterEnum — in-service encashment requests route through their own WorkflowModule
-- so the approval-engine consumer never collides with the LEAVE consumer's
-- APPLICATION handler. Additive value; ADD VALUE IF NOT EXISTS is idempotent.
ALTER TYPE "WorkflowModule" ADD VALUE IF NOT EXISTS 'LEAVE_ENCASHMENT';

-- AlterTable — IN-SERVICE encashment policy knobs (beside the EXIT encashOnExit ones).
-- All defaulted; NZ tenants leave them inert. encashMaxDaysPerYear is SEPARATE from the
-- exit maxEncashCap so an employer can cap in-service days yet encash the full balance at exit.
ALTER TABLE "LeavePolicy" ADD COLUMN IF NOT EXISTS "encashInService" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LeavePolicy" ADD COLUMN IF NOT EXISTS "encashBasis" "EncashmentBasis" NOT NULL DEFAULT 'BASIC_DA_26';
ALTER TABLE "LeavePolicy" ADD COLUMN IF NOT EXISTS "encashMaxDaysPerYear" DECIMAL(8,4);
ALTER TABLE "LeavePolicy" ADD COLUMN IF NOT EXISTS "encashMinDaysPerRequest" DECIMAL(8,4);
ALTER TABLE "LeavePolicy" ADD COLUMN IF NOT EXISTS "encashMinBalanceAfter" DECIMAL(8,4);
ALTER TABLE "LeavePolicy" ADD COLUMN IF NOT EXISTS "encashMaxRequestsPerYear" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "LeavePolicy" ADD COLUMN IF NOT EXISTS "encashWindowOpenMonth" INTEGER;
ALTER TABLE "LeavePolicy" ADD COLUMN IF NOT EXISTS "encashWindowCloseMonth" INTEGER;
ALTER TABLE "LeavePolicy" ADD COLUMN IF NOT EXISTS "encashPfWages" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LeavePolicy" ADD COLUMN IF NOT EXISTS "encashEsiWages" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LeavePolicy" ADD COLUMN IF NOT EXISTS "encashPtWages" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "LeavePolicy" ADD COLUMN IF NOT EXISTS "encashWorkflowId" TEXT;

-- CreateTable — the in-service encashment request (the only new entity).
CREATE TABLE IF NOT EXISTS "LeaveEncashmentRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "leavePolicyId" TEXT,
    "periodCode" TEXT NOT NULL,
    "days" DECIMAL(8,4) NOT NULL,
    "basis" "EncashmentBasis" NOT NULL,
    "basicDaMonthlyMinor" BIGINT,
    "perDayMinor" BIGINT,
    "amountMinor" BIGINT,
    "reason" TEXT,
    "status" "EncashmentStatus" NOT NULL DEFAULT 'PENDING',
    "approvalRequestId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "encashmentTxnId" TEXT,
    "payRunId" TEXT,
    "paidAmountMinor" BIGINT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LeaveEncashmentRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LeaveEncashmentRequest_businessId_employeeId_status_idx"
    ON "LeaveEncashmentRequest"("businessId", "employeeId", "status");
CREATE INDEX IF NOT EXISTS "LeaveEncashmentRequest_businessId_status_payRunId_idx"
    ON "LeaveEncashmentRequest"("businessId", "status", "payRunId");
CREATE INDEX IF NOT EXISTS "LeaveEncashmentRequest_businessId_leaveTypeId_periodCode_idx"
    ON "LeaveEncashmentRequest"("businessId", "leaveTypeId", "periodCode");

-- FK — Cascade on business/employee (a deleted tenant/employee takes its requests),
-- Restrict on leaveType (a referenced type can't be hard-deleted), matching the
-- LeaveTransaction relations.
DO $$ BEGIN
  ALTER TABLE "LeaveEncashmentRequest"
    ADD CONSTRAINT "LeaveEncashmentRequest_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "LeaveEncashmentRequest"
    ADD CONSTRAINT "LeaveEncashmentRequest_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "LeaveEncashmentRequest"
    ADD CONSTRAINT "LeaveEncashmentRequest_leaveTypeId_fkey"
    FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
