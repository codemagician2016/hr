-- Feature 24 — Form 16 (Part A + Part B) + Form 24Q.
-- ADDITIVE only: two new enums (Form16BatchStatus, Form16CertStatus) and two new
-- tables (Form16Batch, Form16Certificate). No changes to existing data, no NOT NULL
-- on an existing column, no backfill — safe on a live tenant (mirrors the additive
-- migrations of feature21/22). IF NOT EXISTS guards keep it idempotent.
-- RemittanceKind.IN_FORM16 / IN_FORM130 / IN_FORM24Q / IN_FORM138 already exist
-- (Feature 23), so the formKind column needs no new enum value.

-- ── Feature 24: enums ──
DO $$ BEGIN
  CREATE TYPE "Form16BatchStatus" AS ENUM ('DRAFT', 'COMPUTED', 'APPROVED', 'ISSUED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "Form16CertStatus" AS ENUM ('PENDING', 'ISSUED', 'PENDING_SIGNATURE', 'VOIDED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── Feature 24: Form16Batch (one per entity, financial year — maker-checker run) ──
CREATE TABLE IF NOT EXISTS "Form16Batch" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "formKind" "RemittanceKind" NOT NULL DEFAULT 'IN_FORM16',
    "status" "Form16BatchStatus" NOT NULL DEFAULT 'DRAFT',
    "deductorPan" CHAR(10),
    "deductorTan" CHAR(10),
    "deductorName" TEXT,
    "headcount" INTEGER NOT NULL DEFAULT 0,
    "totalTdsDeductedMinor" BIGINT NOT NULL DEFAULT 0,
    "totalTdsDepositedMinor" BIGINT NOT NULL DEFAULT 0,
    "reconciledOk" BOOLEAN NOT NULL DEFAULT false,
    "computedAt" TIMESTAMP(3),
    "computedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "issuedAt" TIMESTAMP(3),
    "issuedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Form16Batch_pkey" PRIMARY KEY ("id")
);

-- ── Feature 24: Form16Certificate (per-employee frozen cert — Part A + Part B) ──
CREATE TABLE IF NOT EXISTS "Form16Certificate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "certificateNo" TEXT NOT NULL,
    "tracesCertNo" TEXT,
    "regime" "INTaxRegime" NOT NULL,
    "partAJson" JSONB NOT NULL,
    "partBJson" JSONB NOT NULL,
    "grossSalaryMinor" BIGINT NOT NULL DEFAULT 0,
    "totalTaxableMinor" BIGINT NOT NULL DEFAULT 0,
    "totalTaxMinor" BIGINT NOT NULL DEFAULT 0,
    "tdsDeductedMinor" BIGINT NOT NULL DEFAULT 0,
    "tdsDepositedMinor" BIGINT NOT NULL DEFAULT 0,
    "anomaliesJson" JSONB,
    "issuedLetterId" TEXT,
    "employeeDocumentId" TEXT,
    "fileHash" TEXT,
    "signatureEnvelopeId" TEXT,
    "status" "Form16CertStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Form16Certificate_pkey" PRIMARY KEY ("id")
);

-- Unique + indexes.
CREATE UNIQUE INDEX IF NOT EXISTS "Form16Batch_businessId_entityId_financialYear_key" ON "Form16Batch"("businessId", "entityId", "financialYear");
CREATE INDEX IF NOT EXISTS "Form16Batch_businessId_status_idx" ON "Form16Batch"("businessId", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "Form16Certificate_businessId_batchId_employeeId_key" ON "Form16Certificate"("businessId", "batchId", "employeeId");
CREATE UNIQUE INDEX IF NOT EXISTS "Form16Certificate_businessId_certificateNo_key" ON "Form16Certificate"("businessId", "certificateNo");
CREATE INDEX IF NOT EXISTS "Form16Certificate_businessId_employeeId_financialYear_idx" ON "Form16Certificate"("businessId", "employeeId", "financialYear");
CREATE INDEX IF NOT EXISTS "Form16Certificate_businessId_status_idx" ON "Form16Certificate"("businessId", "status");

-- Foreign keys (guarded so a re-apply on an already-migrated schema is a no-op).
DO $$ BEGIN
  ALTER TABLE "Form16Batch" ADD CONSTRAINT "Form16Batch_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "Form16Batch" ADD CONSTRAINT "Form16Batch_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "Form16Certificate" ADD CONSTRAINT "Form16Certificate_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "Form16Certificate" ADD CONSTRAINT "Form16Certificate_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Form16Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "Form16Certificate" ADD CONSTRAINT "Form16Certificate_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
