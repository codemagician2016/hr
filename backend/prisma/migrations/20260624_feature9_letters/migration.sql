-- Feature 9 (Letters & Communication) — Slice 9A. Additive only. Hand-authored to
-- be idempotent so it applies cleanly to the isolated hr_test schema (bootstrapped
-- via `prisma db push`) as well as a clean migrate-deploy on the box (psql stdin).
-- Every CREATE / ADD uses IF NOT EXISTS (or the DO-block guard for enums + FK +
-- partial uniques, which lack IF NOT EXISTS for the object itself).
--
-- Adds: 2 enums (LetterCategory, IssuedLetterStatus), 3 tables (CompanyLetterhead,
-- LetterTemplate, IssuedLetter), the SignatureEnvelope.issuedLetterId pointer, plus
-- the two raw-SQL partial-unique indexes from §3.2 that Prisma cannot express.

-- ── Enums (guarded; CREATE TYPE has no IF NOT EXISTS) ────────────────────────────
DO $$ BEGIN CREATE TYPE "LetterCategory" AS ENUM ('EXPERIENCE','BONAFIDE','EMPLOYMENT_PROOF','SALARY_PROOF','BANK','CONTRACT','CUSTOM'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "IssuedLetterStatus" AS ENUM ('DRAFT','PENDING_SIGNATURE','ISSUED','DELIVERED','VOIDED'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── SignatureEnvelope additive pointer ──────────────────────────────────────────
ALTER TABLE "SignatureEnvelope" ADD COLUMN IF NOT EXISTS "issuedLetterId" TEXT;

-- ── CompanyLetterhead — uploaded A4 PDF + visual layout (config; soft-deletable) ─
CREATE TABLE IF NOT EXISTS "CompanyLetterhead" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "entityId" TEXT,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "fileUrl" TEXT NOT NULL,
  "fileHash" TEXT,
  "mimeType" TEXT DEFAULT 'application/pdf',
  "sizeBytes" INTEGER,
  "pageWidthPt" DOUBLE PRECISION,
  "pageHeightPt" DOUBLE PRECISION,
  "layoutJson" JSONB NOT NULL,
  "fontKey" TEXT DEFAULT 'noto-sans',
  "letterCategory" "LetterCategory",
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "CompanyLetterhead_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CompanyLetterhead_businessId_code_key" ON "CompanyLetterhead"("businessId","code");
CREATE INDEX IF NOT EXISTS "CompanyLetterhead_businessId_entityId_isActive_idx" ON "CompanyLetterhead"("businessId","entityId","isActive");
CREATE INDEX IF NOT EXISTS "CompanyLetterhead_businessId_letterCategory_isActive_idx" ON "CompanyLetterhead"("businessId","letterCategory","isActive");

-- ── LetterTemplate — reusable body + merge fields, versioned (config) ───────────
CREATE TABLE IF NOT EXISTS "LetterTemplate" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "entityId" TEXT,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "category" "LetterCategory" NOT NULL,
  "countryCode" CHAR(2),
  "subject" TEXT,
  "bodyMarkdown" TEXT NOT NULL,
  "mergeFieldsJson" JSONB,
  "defaultLetterheadId" TEXT,
  "requiresSignature" BOOLEAN NOT NULL DEFAULT false,
  "refNoPrefix" TEXT,
  "locale" TEXT,
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "LetterTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "LetterTemplate_businessId_code_key" ON "LetterTemplate"("businessId","code");
CREATE INDEX IF NOT EXISTS "LetterTemplate_businessId_category_isActive_idx" ON "LetterTemplate"("businessId","category","isActive");
CREATE INDEX IF NOT EXISTS "LetterTemplate_businessId_countryCode_category_idx" ON "LetterTemplate"("businessId","countryCode","category");

-- ── IssuedLetter — immutable issuance record (NEVER soft-deleted; legal record) ──
CREATE TABLE IF NOT EXISTS "IssuedLetter" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "entityId" TEXT,
  "referenceNo" TEXT NOT NULL,
  "category" "LetterCategory" NOT NULL,
  "employeeId" TEXT,
  "templateId" TEXT,
  "letterheadId" TEXT,
  "subject" TEXT,
  "renderedBody" TEXT NOT NULL,
  "mergeDataJson" JSONB NOT NULL,
  "templateVersionAtIssue" INTEGER,
  "letterheadHash" TEXT,
  "fileUrl" TEXT,
  "fileHash" TEXT,
  "mimeType" TEXT DEFAULT 'application/pdf',
  "sizeBytes" INTEGER,
  "status" "IssuedLetterStatus" NOT NULL DEFAULT 'DRAFT',
  "signatureEnvelopeId" TEXT,
  "employeeDocumentId" TEXT,
  "documentRequestId" TEXT,
  "issuedBy" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "deliveryChannel" TEXT,
  "seqScope" TEXT NOT NULL DEFAULT 'LETTER',
  "seqPeriodKey" TEXT,
  "seqValue" INTEGER,
  "supersedesLetterId" TEXT,
  "supersededByLetterId" TEXT,
  "voidedAt" TIMESTAMP(3),
  "voidedBy" TEXT,
  "voidReason" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "IssuedLetter_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "IssuedLetter_businessId_referenceNo_key" ON "IssuedLetter"("businessId","referenceNo");
CREATE INDEX IF NOT EXISTS "IssuedLetter_businessId_employeeId_category_issuedAt_idx" ON "IssuedLetter"("businessId","employeeId","category","issuedAt");
CREATE INDEX IF NOT EXISTS "IssuedLetter_businessId_category_status_idx" ON "IssuedLetter"("businessId","category","status");
CREATE INDEX IF NOT EXISTS "IssuedLetter_businessId_entityId_seqScope_seqPeriodKey_idx" ON "IssuedLetter"("businessId","entityId","seqScope","seqPeriodKey");

-- ── §3.2 partial-unique invariants (Prisma cannot express WHERE-filtered uniques) ─
-- One default letterhead per (tenant, entity).
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_letterhead_default"
  ON "CompanyLetterhead"("businessId","entityId")
  WHERE "isDefault" AND "deletedAt" IS NULL;
-- One letterhead per category per (tenant, entity).
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_letterhead_category"
  ON "CompanyLetterhead"("businessId","entityId","letterCategory")
  WHERE "letterCategory" IS NOT NULL AND "deletedAt" IS NULL;

-- ── AddForeignKey (guarded — ADD CONSTRAINT has no IF NOT EXISTS) ───────────────
DO $$ BEGIN
  ALTER TABLE "CompanyLetterhead" ADD CONSTRAINT "CompanyLetterhead_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "LetterTemplate" ADD CONSTRAINT "LetterTemplate_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "LetterTemplate" ADD CONSTRAINT "LetterTemplate_defaultLetterheadId_fkey" FOREIGN KEY ("defaultLetterheadId") REFERENCES "CompanyLetterhead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "IssuedLetter" ADD CONSTRAINT "IssuedLetter_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "IssuedLetter" ADD CONSTRAINT "IssuedLetter_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "IssuedLetter" ADD CONSTRAINT "IssuedLetter_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "LetterTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "IssuedLetter" ADD CONSTRAINT "IssuedLetter_letterheadId_fkey" FOREIGN KEY ("letterheadId") REFERENCES "CompanyLetterhead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
