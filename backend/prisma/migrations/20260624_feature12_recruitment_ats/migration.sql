-- Feature 12 (Recruitment / ATS — configurable scoring + merit list) — additive
-- only. Hand-authored to be idempotent so it applies cleanly to the isolated
-- hr_test schema (bootstrapped via `prisma db push`) as well as a clean
-- migrate-deploy. Every CREATE / ADD uses IF NOT EXISTS (or the DO-block guard
-- for enums, which lack IF NOT EXISTS for the type itself).
--
-- Reuses the existing ATS spine (Job/JobStage/Candidate/Application/Interview/
-- Offer); adds (a) screening questions + options + append-only answers, (b)
-- interview scorecard templates + skills + per-interviewer cards + ratings, and
-- (c) the three score columns + explainable snapshot on Application.

-- ── Enums (guarded; CREATE TYPE has no IF NOT EXISTS) ────────────────────────────
DO $$ BEGIN CREATE TYPE "ApplicationSource" AS ENUM ('PUBLIC','REFERRAL','AGENCY','MANUAL','IMPORT'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "ScreeningKind" AS ENUM ('BOOLEAN','SINGLE_CHOICE','MULTI_CHOICE','NUMBER','TEXT','QUALIFICATION'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "ScorecardAggregation" AS ENUM ('MEAN','TRIMMED_MEAN','MAX','MEDIAN'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "ScorecardStatus" AS ENUM ('DRAFT','SUBMITTED'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── Job: public posting + merit-blend + scoring config ───────────────────────────
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "publicSlug" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "applicationWeightPct" DECIMAL(5,2) NOT NULL DEFAULT 40;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "interviewWeightPct" DECIMAL(5,2) NOT NULL DEFAULT 60;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "scorecardTemplateId" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "hideCandidatePiiUntilStage" "StageKind";
CREATE UNIQUE INDEX IF NOT EXISTS "Job_businessId_publicSlug_key" ON "Job"("businessId","publicSlug");

-- ── Application: the three score components + explainable snapshot ───────────────
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "screeningScore" DECIMAL(7,2);
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "screeningMaxScore" DECIMAL(7,2);
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "knockedOut" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "interviewScore" DECIMAL(7,2);
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "meritScore" DECIMAL(7,2);
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "scoreSnapshot" JSONB;
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "appliedSource" "ApplicationSource" NOT NULL DEFAULT 'MANUAL';
CREATE INDEX IF NOT EXISTS "Application_businessId_jobId_meritScore_idx" ON "Application"("businessId","jobId","meritScore");

-- ── Interview: scorecard template + slot/invitation details ─────────────────────
ALTER TABLE "Interview" ADD COLUMN IF NOT EXISTS "scorecardTemplateId" TEXT;
ALTER TABLE "Interview" ADD COLUMN IF NOT EXISTS "durationMins" INTEGER DEFAULT 45;
ALTER TABLE "Interview" ADD COLUMN IF NOT EXISTS "locationText" TEXT;
ALTER TABLE "Interview" ADD COLUMN IF NOT EXISTS "videoUrl" TEXT;
ALTER TABLE "Interview" ADD COLUMN IF NOT EXISTS "candidateInviteSentAt" TIMESTAMP(3);
ALTER TABLE "Interview" ADD COLUMN IF NOT EXISTS "panelInviteSentAt" TIMESTAMP(3);

-- ── Offer: optional offer-letter e-signature envelope ───────────────────────────
ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "signatureEnvelopeId" TEXT;

-- ── ScreeningQuestion ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ScreeningQuestion" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "kind" "ScreeningKind" NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT true,
  "isKnockout" BOOLEAN NOT NULL DEFAULT false,
  "knockoutValue" JSONB,
  "maxPoints" DECIMAL(7,2),
  "sortOrder" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "ScreeningQuestion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ScreeningQuestion_businessId_jobId_sortOrder_key" ON "ScreeningQuestion"("businessId","jobId","sortOrder");
CREATE INDEX IF NOT EXISTS "ScreeningQuestion_businessId_jobId_idx" ON "ScreeningQuestion"("businessId","jobId");

-- ── ScreeningOption ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ScreeningOption" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "questionId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "points" DECIMAL(7,2) NOT NULL DEFAULT 0,
  "sortOrder" INTEGER NOT NULL,
  CONSTRAINT "ScreeningOption_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ScreeningOption_businessId_questionId_idx" ON "ScreeningOption"("businessId","questionId");

-- ── ScreeningAnswer (append-only ledger) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ScreeningAnswer" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "questionId" TEXT NOT NULL,
  "questionPrompt" TEXT NOT NULL,
  "answerValue" JSONB NOT NULL,
  "pointsAwarded" DECIMAL(7,2) NOT NULL DEFAULT 0,
  "knockoutFailed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScreeningAnswer_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ScreeningAnswer_businessId_applicationId_idx" ON "ScreeningAnswer"("businessId","applicationId");

-- ── ScorecardTemplate ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ScorecardTemplate" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "aggregation" "ScorecardAggregation" NOT NULL DEFAULT 'MEAN',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ScorecardTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ScorecardTemplate_businessId_name_key" ON "ScorecardTemplate"("businessId","name");
CREATE INDEX IF NOT EXISTS "ScorecardTemplate_businessId_isActive_idx" ON "ScorecardTemplate"("businessId","isActive");

-- ── ScorecardSkill ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ScorecardSkill" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "weight" DECIMAL(5,2) NOT NULL DEFAULT 1,
  "scaleMin" INTEGER NOT NULL DEFAULT 1,
  "scaleMax" INTEGER NOT NULL DEFAULT 10,
  "sortOrder" INTEGER NOT NULL,
  CONSTRAINT "ScorecardSkill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ScorecardSkill_businessId_templateId_sortOrder_key" ON "ScorecardSkill"("businessId","templateId","sortOrder");
CREATE INDEX IF NOT EXISTS "ScorecardSkill_businessId_templateId_idx" ON "ScorecardSkill"("businessId","templateId");

-- ── Scorecard (one per interviewer per interview) ───────────────────────────────
CREATE TABLE IF NOT EXISTS "Scorecard" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "interviewId" TEXT NOT NULL,
  "interviewerEmployeeId" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "status" "ScorecardStatus" NOT NULL DEFAULT 'DRAFT',
  "weightedTotal" DECIMAL(7,2),
  "recommendation" "InterviewRecommendation",
  "notes" TEXT,
  "submittedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "Scorecard_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Scorecard_businessId_interviewId_interviewerEmployeeId_key" ON "Scorecard"("businessId","interviewId","interviewerEmployeeId");
CREATE INDEX IF NOT EXISTS "Scorecard_businessId_interviewId_idx" ON "Scorecard"("businessId","interviewId");

-- ── ScorecardRating (append-only per skill) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ScorecardRating" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "scorecardId" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "skillName" TEXT NOT NULL,
  "weight" DECIMAL(5,2) NOT NULL,
  "score" INTEGER NOT NULL,
  "comment" TEXT,
  CONSTRAINT "ScorecardRating_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ScorecardRating_businessId_scorecardId_skillId_key" ON "ScorecardRating"("businessId","scorecardId","skillId");
CREATE INDEX IF NOT EXISTS "ScorecardRating_businessId_scorecardId_idx" ON "ScorecardRating"("businessId","scorecardId");

-- ── Foreign keys (guarded; ADD CONSTRAINT has no IF NOT EXISTS) ──────────────────
DO $$ BEGIN
  ALTER TABLE "ScreeningQuestion" ADD CONSTRAINT "ScreeningQuestion_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ScreeningQuestion" ADD CONSTRAINT "ScreeningQuestion_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ScreeningOption" ADD CONSTRAINT "ScreeningOption_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "ScreeningQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ScreeningAnswer" ADD CONSTRAINT "ScreeningAnswer_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ScorecardTemplate" ADD CONSTRAINT "ScorecardTemplate_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ScorecardSkill" ADD CONSTRAINT "ScorecardSkill_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ScorecardTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "Scorecard" ADD CONSTRAINT "Scorecard_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ScorecardRating" ADD CONSTRAINT "ScorecardRating_scorecardId_fkey" FOREIGN KEY ("scorecardId") REFERENCES "Scorecard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
