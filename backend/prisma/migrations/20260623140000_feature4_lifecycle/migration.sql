-- Feature 4 (Employee Lifecycle) §3.2/§3.3 — onboarding/offboarding journey + built-in e-sign.
-- Additive only (no destructive change). Hand-authored to be idempotent so it can be
-- applied to the isolated hr_test schema (which was bootstrapped via `prisma db push`)
-- without a clean migrate-deploy: every CREATE TYPE is DO-block guarded, every table /
-- index uses IF NOT EXISTS, and every FK is added only if absent.

-- ── CreateEnum (guarded — CREATE TYPE has no IF NOT EXISTS) ──
DO $$ BEGIN
  CREATE TYPE "LifecycleDirection" AS ENUM ('ONBOARDING', 'OFFBOARDING');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LifecycleStage" AS ENUM ('PRE_JOIN', 'SELF_ONBOARDING', 'DOCS_ESIGN', 'PROVISIONING', 'DAY_ONE', 'WEEK_ONE', 'PROBATION', 'SEPARATION_INITIATED', 'NOTICE', 'CLEARANCE', 'ASSET_RETURN', 'FNF', 'EXIT_DOCS', 'POST_EXIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "TaskOwner" AS ENUM ('NEW_HIRE', 'EMPLOYEE', 'MANAGER', 'HR', 'IT', 'FINANCE', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DueAnchor" AS ENUM ('OFFER_ACCEPT', 'JOIN_DATE', 'NOTICE_START', 'LWD', 'RELIEVING');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LifecycleTaskKey" AS ENUM ('COLLECT_PERSONAL', 'COLLECT_STATUTORY', 'COLLECT_BANK', 'COLLECT_EMERGENCY', 'UPLOAD_DOCS', 'ESIGN_OFFER', 'ESIGN_CONTRACT', 'ESIGN_POLICIES', 'PROVISION_EMPLOYEE', 'ASSIGN_ASSET', 'VERIFY_DOCS', 'PROBATION_REVIEW', 'ACCEPT_RESIGNATION', 'KNOWLEDGE_TRANSFER', 'RETURN_ASSET', 'CLEARANCE_IT', 'CLEARANCE_FINANCE', 'CLEARANCE_ADMIN', 'COMPUTE_FNF', 'GENERATE_RELIEVING', 'GENERATE_EXPERIENCE', 'EXIT_INTERVIEW', 'REVOKE_ACCESS', 'CUSTOM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "JourneyStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'ON_HOLD', 'COMPLETED', 'CANCELLED', 'RESCINDED', 'NO_SHOW');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'WAITING_APPROVAL', 'BLOCKED', 'DONE', 'SKIPPED', 'NOT_APPLICABLE', 'OVERDUE', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "EsignProvider" AS ENUM ('BUILTIN', 'DOCUSIGN', 'ZOHO_SIGN', 'ADOBE_SIGN', 'DIGIO', 'LEEGALITY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "EnvelopeStatus" AS ENUM ('DRAFT', 'SENT', 'DELIVERED', 'PARTIALLY_SIGNED', 'COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED', 'ERROR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SignerRole" AS ENUM ('EMPLOYEE', 'EMPLOYER', 'WITNESS', 'APPROVER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SignerStatus" AS ENUM ('PENDING', 'SENT', 'VIEWED', 'SIGNED', 'DECLINED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── CreateTable ──
CREATE TABLE IF NOT EXISTS "LifecycleTemplate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "direction" "LifecycleDirection" NOT NULL,
    "countryCode" CHAR(2),
    "departmentId" TEXT,
    "designationId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "LifecycleTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "LifecycleTaskDef" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "stageKey" "LifecycleStage" NOT NULL,
    "taskKey" "LifecycleTaskKey",
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerRole" "TaskOwner" NOT NULL,
    "taskOrder" INTEGER NOT NULL DEFAULT 0,
    "dueOffsetDays" INTEGER NOT NULL DEFAULT 0,
    "dueAnchor" "DueAnchor" NOT NULL DEFAULT 'JOIN_DATE',
    "isBlocking" BOOLEAN NOT NULL DEFAULT true,
    "isMandatory" BOOLEAN NOT NULL DEFAULT true,
    "documentCategory" "DocumentCategory",
    "esignTemplateKind" "TemplateKind",
    "assetCategory" "AssetCategory",

    CONSTRAINT "LifecycleTaskDef_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "LifecycleJourney" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "code" TEXT NOT NULL,
    "direction" "LifecycleDirection" NOT NULL,
    "templateId" TEXT,
    "offerId" TEXT,
    "employeeId" TEXT,
    "separationId" TEXT,
    "offerAcceptedAt" TIMESTAMP(3),
    "joinDate" DATE,
    "noticeStartDate" DATE,
    "lastWorkingDay" DATE,
    "relievingDate" DATE,
    "currentStage" "LifecycleStage" NOT NULL,
    "status" "JourneyStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "selfServiceJson" JSONB,
    "preJoinTokenHash" TEXT,
    "preJoinTokenExpiresAt" TIMESTAMP(3),
    "meta" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "LifecycleJourney_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "LifecycleTask" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "taskDefId" TEXT,
    "stageKey" "LifecycleStage" NOT NULL,
    "taskKey" "LifecycleTaskKey",
    "title" TEXT NOT NULL,
    "ownerRole" "TaskOwner" NOT NULL,
    "assigneeEmployeeId" TEXT,
    "assigneeUserId" TEXT,
    "dueDate" DATE,
    "isBlocking" BOOLEAN NOT NULL DEFAULT true,
    "isMandatory" BOOLEAN NOT NULL DEFAULT true,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "employeeDocumentId" TEXT,
    "signatureEnvelopeId" TEXT,
    "assetAssignmentId" TEXT,
    "approvalRequestId" TEXT,
    "resultJson" JSONB,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "skippedReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LifecycleTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SignatureEnvelope" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeDocumentId" TEXT,
    "documentTemplateId" TEXT,
    "provider" "EsignProvider" NOT NULL DEFAULT 'BUILTIN',
    "providerEnvelopeId" TEXT,
    "subject" TEXT NOT NULL,
    "status" "EnvelopeStatus" NOT NULL DEFAULT 'DRAFT',
    "finalFileUrl" TEXT,
    "certificateUrl" TEXT,
    "sequential" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "voidedReason" TEXT,
    "webhookSecret" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignatureEnvelope_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SignatureSigner" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "signerOrder" INTEGER NOT NULL DEFAULT 1,
    "role" "SignerRole" NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "employeeId" TEXT,
    "userId" TEXT,
    "status" "SignerStatus" NOT NULL DEFAULT 'PENDING',
    "accessTokenHash" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "declinedReason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "consentAt" TIMESTAMP(3),
    "signatureImageUrl" TEXT,
    "signatureHash" TEXT,

    CONSTRAINT "SignatureSigner_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ──
CREATE INDEX IF NOT EXISTS "LifecycleTemplate_businessId_direction_isActive_idx" ON "LifecycleTemplate"("businessId", "direction", "isActive");
CREATE UNIQUE INDEX IF NOT EXISTS "LifecycleTemplate_businessId_code_key" ON "LifecycleTemplate"("businessId", "code");

CREATE INDEX IF NOT EXISTS "LifecycleTaskDef_businessId_templateId_stageKey_idx" ON "LifecycleTaskDef"("businessId", "templateId", "stageKey");

CREATE UNIQUE INDEX IF NOT EXISTS "LifecycleJourney_offerId_key" ON "LifecycleJourney"("offerId");
CREATE UNIQUE INDEX IF NOT EXISTS "LifecycleJourney_separationId_key" ON "LifecycleJourney"("separationId");
CREATE INDEX IF NOT EXISTS "LifecycleJourney_businessId_direction_status_idx" ON "LifecycleJourney"("businessId", "direction", "status");
CREATE INDEX IF NOT EXISTS "LifecycleJourney_businessId_employeeId_idx" ON "LifecycleJourney"("businessId", "employeeId");
CREATE UNIQUE INDEX IF NOT EXISTS "LifecycleJourney_businessId_code_key" ON "LifecycleJourney"("businessId", "code");

CREATE INDEX IF NOT EXISTS "LifecycleTask_businessId_journeyId_stageKey_idx" ON "LifecycleTask"("businessId", "journeyId", "stageKey");
CREATE INDEX IF NOT EXISTS "LifecycleTask_businessId_assigneeEmployeeId_status_idx" ON "LifecycleTask"("businessId", "assigneeEmployeeId", "status");
CREATE INDEX IF NOT EXISTS "LifecycleTask_businessId_status_dueDate_idx" ON "LifecycleTask"("businessId", "status", "dueDate");

CREATE INDEX IF NOT EXISTS "SignatureEnvelope_businessId_status_idx" ON "SignatureEnvelope"("businessId", "status");

CREATE INDEX IF NOT EXISTS "SignatureSigner_businessId_envelopeId_status_idx" ON "SignatureSigner"("businessId", "envelopeId", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureSigner_businessId_envelopeId_signerOrder_key" ON "SignatureSigner"("businessId", "envelopeId", "signerOrder");

-- ── §3.3 partial-unique indexes (Prisma cannot express WHERE-filtered uniques) ──
-- One active onboarding journey per accepted Offer (the acceptOffer idempotency backstop).
-- Column names are the camelCase identifiers Prisma emits (no @map in this schema).
CREATE UNIQUE INDEX IF NOT EXISTS "onb_one_active_per_offer"
  ON "LifecycleJourney"("businessId", "offerId")
  WHERE "direction" = 'ONBOARDING' AND "deletedAt" IS NULL;

-- One active offboarding journey per employee (mirrors SeparationCase's active-case guard).
CREATE UNIQUE INDEX IF NOT EXISTS "ofb_one_active_per_employee"
  ON "LifecycleJourney"("businessId", "employeeId")
  WHERE "direction" = 'OFFBOARDING' AND "deletedAt" IS NULL;

-- ── AddForeignKey (guarded — ADD CONSTRAINT has no IF NOT EXISTS) ──
DO $$ BEGIN
  ALTER TABLE "LifecycleTemplate" ADD CONSTRAINT "LifecycleTemplate_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "LifecycleTaskDef" ADD CONSTRAINT "LifecycleTaskDef_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "LifecycleTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "LifecycleJourney" ADD CONSTRAINT "LifecycleJourney_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "LifecycleTask" ADD CONSTRAINT "LifecycleTask_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "LifecycleJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "SignatureEnvelope" ADD CONSTRAINT "SignatureEnvelope_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "SignatureSigner" ADD CONSTRAINT "SignatureSigner_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "SignatureEnvelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
