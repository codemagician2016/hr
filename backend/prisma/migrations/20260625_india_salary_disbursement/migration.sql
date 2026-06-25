-- India salary disbursement (NET-NEW). Converts a computed/approved PayRun into a
-- bank-uploadable salary-advice batch (PayoutBatch) of per-employee credit lines
-- (PayoutLine), with status reconciliation. India-first; NZ untouched.
--
-- PURELY ADDITIVE: three new enums (PayoutBank / PayoutBatchStatus /
-- PayoutLineStatus) + two new tables (PayoutBatch, PayoutLine). NO ALTER of any
-- existing table, NO NOT NULL on an existing column, NO backfill — safe on a live
-- tenant (mirrors the additive migrations of feature24/27/31/32). IF NOT EXISTS /
-- DO-block guards keep it idempotent for db-push parity + re-runs.
--
-- MONEY: amounts are INTEGER MINOR UNITS (paise) — stored as BIGINT (totalMinor,
-- amountMinor). Never floats.

-- ── Enums ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "PayoutBank" AS ENUM ('HDFC', 'ICICI', 'AXIS', 'KOTAK', 'SBI', 'NEFT_RTGS');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "PayoutBatchStatus" AS ENUM ('QUEUED', 'PROCESSING', 'PARTIAL', 'CREDITED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "PayoutLineStatus" AS ENUM ('PENDING', 'CREDITED', 'FAILED', 'RETURNED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── PayoutBatch — one salary-advice batch (a PayRun on one bank rail) ──────────
CREATE TABLE IF NOT EXISTS "PayoutBatch" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "payRunId" TEXT NOT NULL,
    "bank" "PayoutBank" NOT NULL,
    "status" "PayoutBatchStatus" NOT NULL DEFAULT 'QUEUED',
    "totalMinor" BIGINT NOT NULL DEFAULT 0,
    "count" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" CHAR(3) NOT NULL,
    "debitAccount" TEXT,
    "valueDate" DATE,
    "gatewayProvider" TEXT,
    "gatewayBatchId" TEXT,
    "createdBy" TEXT NOT NULL,
    "fileGeneratedAt" TIMESTAMP(3),
    "reconciledAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PayoutBatch_pkey" PRIMARY KEY ("id")
);

-- ── PayoutLine — per-employee credit instruction (bank details snapshot) ──────
CREATE TABLE IF NOT EXISTS "PayoutLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "beneficiaryName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "ifsc" CHAR(11) NOT NULL,
    "narration" TEXT,
    "status" "PayoutLineStatus" NOT NULL DEFAULT 'PENDING',
    "utr" TEXT,
    "failureReason" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PayoutLine_pkey" PRIMARY KEY ("id")
);

-- ── Indexes (tenant-walled; the lookups the console + reconcile perform) ───────
CREATE INDEX IF NOT EXISTS "PayoutBatch_businessId_payRunId_idx"
    ON "PayoutBatch" ("businessId", "payRunId");
CREATE INDEX IF NOT EXISTS "PayoutBatch_businessId_status_idx"
    ON "PayoutBatch" ("businessId", "status");

CREATE INDEX IF NOT EXISTS "PayoutLine_businessId_batchId_status_idx"
    ON "PayoutLine" ("businessId", "batchId", "status");
CREATE INDEX IF NOT EXISTS "PayoutLine_businessId_employeeId_idx"
    ON "PayoutLine" ("businessId", "employeeId");

-- ── Foreign keys (guarded; tenant CASCADE; payRun/employee RESTRICT; line→batch CASCADE) ─
DO $$ BEGIN
  ALTER TABLE "PayoutBatch"
    ADD CONSTRAINT "PayoutBatch_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "PayoutBatch"
    ADD CONSTRAINT "PayoutBatch_payRunId_fkey"
    FOREIGN KEY ("payRunId") REFERENCES "PayRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "PayoutLine"
    ADD CONSTRAINT "PayoutLine_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "PayoutLine"
    ADD CONSTRAINT "PayoutLine_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "PayoutBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "PayoutLine"
    ADD CONSTRAINT "PayoutLine_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
