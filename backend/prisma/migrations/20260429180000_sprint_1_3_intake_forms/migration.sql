-- Sprint 1.3 — Advanced intake forms (Pro tier)
-- Two new tables + one nullable FK on Service. Additive; existing rows
-- unaffected. No data backfill required.

-- 1) IntakeForm — per-tenant reusable form definitions
CREATE TABLE "IntakeForm" (
  "id"          TEXT NOT NULL,
  "businessId"  TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "fields"      JSONB NOT NULL DEFAULT '[]',
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntakeForm_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IntakeForm_businessId_isActive_idx"
  ON "IntakeForm"("businessId", "isActive");
ALTER TABLE "IntakeForm"
  ADD CONSTRAINT "IntakeForm_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2) IntakeSubmission — one row per filled form
CREATE TABLE "IntakeSubmission" (
  "id"             TEXT NOT NULL,
  "businessId"     TEXT NOT NULL,
  "formId"         TEXT NOT NULL,
  "appointmentId"  TEXT,
  "customerId"     TEXT,
  "customerEmail"  TEXT,
  "customerName"   TEXT,
  "answers"        JSONB NOT NULL DEFAULT '{}',
  "fieldsSnapshot" JSONB NOT NULL DEFAULT '[]',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntakeSubmission_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IntakeSubmission_businessId_createdAt_idx"
  ON "IntakeSubmission"("businessId", "createdAt");
CREATE INDEX "IntakeSubmission_appointmentId_idx"
  ON "IntakeSubmission"("appointmentId");
CREATE INDEX "IntakeSubmission_formId_idx"
  ON "IntakeSubmission"("formId");
CREATE INDEX "IntakeSubmission_customerId_idx"
  ON "IntakeSubmission"("customerId");
ALTER TABLE "IntakeSubmission"
  ADD CONSTRAINT "IntakeSubmission_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntakeSubmission"
  ADD CONSTRAINT "IntakeSubmission_formId_fkey"
  FOREIGN KEY ("formId") REFERENCES "IntakeForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) Service.intakeFormId — nullable FK to IntakeForm
ALTER TABLE "Service"
  ADD COLUMN "intakeFormId" TEXT;
ALTER TABLE "Service"
  ADD CONSTRAINT "Service_intakeFormId_fkey"
  FOREIGN KEY ("intakeFormId") REFERENCES "IntakeForm"("id") ON DELETE SET NULL ON UPDATE CASCADE;
