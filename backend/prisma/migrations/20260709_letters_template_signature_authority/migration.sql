-- Feature 9 (Letters), Phase 2 — per-template STATIC signature image (uploaded
-- once, auto-stamped on every issued letter) + the authority/signatory block text
-- (fixes the previously-blank {{authority.*}} / {{company.signatory*}} tokens).
-- All columns are additive + nullable (signatureOnLastPage defaults true), so this
-- is a safe forward-only migration with no backfill.
ALTER TABLE "LetterTemplate"
  ADD COLUMN "signatureImageUrl" TEXT,
  ADD COLUMN "signatureImageHash" TEXT,
  ADD COLUMN "signatureMimeType" TEXT,
  ADD COLUMN "signatureSizeBytes" INTEGER,
  ADD COLUMN "signatureBoxJson" JSONB,
  ADD COLUMN "signatureOnLastPage" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "authorityName" TEXT,
  ADD COLUMN "authorityDesignation" TEXT;
