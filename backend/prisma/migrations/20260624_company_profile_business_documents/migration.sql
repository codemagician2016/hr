-- Company Profile — Business Document vault. Additive only. Hand-authored to be
-- idempotent so it applies cleanly to the isolated hr_test schema (bootstrapped
-- via `prisma db push`) as well as a clean migrate-deploy on the box (psql stdin).
-- Every CREATE / ADD uses IF NOT EXISTS (or the DO-block guard for the enum + FK,
-- which lack IF NOT EXISTS for the object itself).
--
-- Adds: 1 enum (BusinessDocumentCategory) + 1 table (BusinessDocument) + the
-- Business.companyProfile JSON column (India-first legal/registration profile).
-- The per-tenant employee-numbering scheme reuses the existing NumberSequence
-- table (no schema change) via the EMPLOYEE scope, so nothing is added for it.

-- ── Business.companyProfile — India-first legal/registration profile (JSON) ──────
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "companyProfile" JSONB;

-- ── Enum (guarded; CREATE TYPE has no IF NOT EXISTS) ─────────────────────────────
DO $$ BEGIN
  CREATE TYPE "BusinessDocumentCategory" AS ENUM (
    'BUSINESS_LICENSE','INCOME_TAX_REPORT','FINANCIAL_STATEMENT',
    'REGISTRATION_CERTIFICATE','GST_CERTIFICATE','OTHER'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── BusinessDocument — company-level document vault (optional, soft-deletable) ───
CREATE TABLE IF NOT EXISTS "BusinessDocument" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "category" "BusinessDocumentCategory" NOT NULL,
  "name" TEXT NOT NULL,
  "fileUrl" TEXT NOT NULL,
  "fileHash" TEXT,
  "mimeType" TEXT,
  "sizeBytes" INTEGER,
  "uploadedBy" TEXT,
  "expiresAt" DATE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "BusinessDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BusinessDocument_businessId_category_idx" ON "BusinessDocument"("businessId","category");
CREATE INDEX IF NOT EXISTS "BusinessDocument_businessId_expiresAt_idx" ON "BusinessDocument"("businessId","expiresAt");

-- ── AddForeignKey (guarded — ADD CONSTRAINT has no IF NOT EXISTS) ────────────────
DO $$ BEGIN
  ALTER TABLE "BusinessDocument" ADD CONSTRAINT "BusinessDocument_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
