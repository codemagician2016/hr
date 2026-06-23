-- Feature 8 (Performance & Goals) — additive only. Hand-authored to be idempotent
-- so it applies cleanly to the isolated hr_test schema (bootstrapped via `prisma db
-- push`) as well as a clean migrate-deploy. Every CREATE / ADD uses IF NOT EXISTS
-- (or the DO-block guard for enums, which lack IF NOT EXISTS for the type itself).
--
-- Closes BUG #2 indirectly: the dead `version` columns already exist; this migration
-- adds the release-gate columns (ReviewCycle.releasedAt, PerformanceReview.releasedAt)
-- and the real FK on linkedCompensationId that the §5 controller now enforces.

-- ── Enums (guarded; CREATE TYPE has no IF NOT EXISTS) ────────────────────────────
DO $$ BEGIN CREATE TYPE "ObjectiveLevel" AS ENUM ('ORG','TEAM','INDIVIDUAL'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "KrMetricType" AS ENUM ('PERCENT','NUMERIC','CURRENCY','BOOLEAN','MILESTONE'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "KrDirection" AS ENUM ('INCREASE','DECREASE','MAINTAIN'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "RagStatus" AS ENUM ('ON_TRACK','AT_RISK','OFF_TRACK'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "GoalVisibility" AS ENUM ('PUBLIC','MANAGER_CHAIN','PRIVATE'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "ReviewPerspective" AS ENUM ('SELF','MANAGER','PEER','SKIP_LEVEL','PRIOR_MANAGER'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "ResponseVisibility" AS ENUM ('SHARED','MANAGER_ONLY','HR_ONLY'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "FeedbackStatus" AS ENUM ('REQUESTED','DECLINED','SUBMITTED','EXPIRED'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "CalibrationStatus" AS ENUM ('OPEN','LOCKED','CLOSED'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "MeritStatus" AS ENUM ('PENDING','APPROVED','APPLIED','REJECTED'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── ReviewCycle additions ────────────────────────────────────────────────────────
ALTER TABLE "ReviewCycle" ADD COLUMN IF NOT EXISTS "templateId" TEXT;
ALTER TABLE "ReviewCycle" ADD COLUMN IF NOT EXISTS "ratingScaleId" TEXT;
ALTER TABLE "ReviewCycle" ADD COLUMN IF NOT EXISTS "releasedAt" TIMESTAMP(3);
ALTER TABLE "ReviewCycle" ADD COLUMN IF NOT EXISTS "goalWeightPct" DECIMAL(5,2);
ALTER TABLE "ReviewCycle" ADD COLUMN IF NOT EXISTS "competencyWeightPct" DECIMAL(5,2);
ALTER TABLE "ReviewCycle" ADD COLUMN IF NOT EXISTS "meritMatrixJson" JSONB;
ALTER TABLE "ReviewCycle" ADD COLUMN IF NOT EXISTS "hrReviewerEmployeeId" TEXT;
ALTER TABLE "ReviewCycle" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

-- ── PerformanceReview additions (ReviewInstance) ────────────────────────────────
ALTER TABLE "PerformanceReview" ADD COLUMN IF NOT EXISTS "subjectSnapshot" JSONB;
ALTER TABLE "PerformanceReview" ADD COLUMN IF NOT EXISTS "proRationFactor" DECIMAL(5,4) NOT NULL DEFAULT 1;
ALTER TABLE "PerformanceReview" ADD COLUMN IF NOT EXISTS "compositeScore" DECIMAL(6,3);
ALTER TABLE "PerformanceReview" ADD COLUMN IF NOT EXISTS "calibratedRating" DECIMAL(4,2);
ALTER TABLE "PerformanceReview" ADD COLUMN IF NOT EXISTS "meritEligible" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PerformanceReview" ADD COLUMN IF NOT EXISTS "releasedAt" TIMESTAMP(3);
ALTER TABLE "PerformanceReview" ADD COLUMN IF NOT EXISTS "acknowledgedAt" TIMESTAMP(3);
ALTER TABLE "PerformanceReview" ADD COLUMN IF NOT EXISTS "rebuttalNote" TEXT;

-- linkedCompensationId: promote loose String? to a real FK (ON DELETE SET NULL).
DO $$ BEGIN
  ALTER TABLE "PerformanceReview"
    ADD CONSTRAINT "PerformanceReview_linkedCompensationId_fkey"
    FOREIGN KEY ("linkedCompensationId") REFERENCES "CompensationRevision"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── Objective ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Objective" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "ownerEmployeeId" TEXT NOT NULL,
  "level" "ObjectiveLevel" NOT NULL,
  "parentObjectiveId" TEXT,
  "cycleId" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "category" "GoalCategory" NOT NULL DEFAULT 'INDIVIDUAL',
  "weight" DECIMAL(5,2) NOT NULL,
  "startDate" DATE,
  "dueDate" DATE NOT NULL,
  "status" "GoalStatus" NOT NULL DEFAULT 'DRAFT',
  "progress" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "visibility" "GoalVisibility" NOT NULL DEFAULT 'PUBLIC',
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Objective_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Objective_businessId_ownerEmployeeId_status_idx" ON "Objective"("businessId","ownerEmployeeId","status");
CREATE INDEX IF NOT EXISTS "Objective_businessId_cycleId_idx" ON "Objective"("businessId","cycleId");

-- ── KeyResult ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "KeyResult" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "objectiveId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "metricType" "KrMetricType" NOT NULL,
  "startValue" DECIMAL(18,4) NOT NULL,
  "targetValue" DECIMAL(18,4) NOT NULL,
  "currentValue" DECIMAL(18,4) NOT NULL,
  "unit" TEXT,
  "direction" "KrDirection" NOT NULL DEFAULT 'INCREASE',
  "weight" DECIMAL(5,2) NOT NULL,
  "confidence" "RagStatus" NOT NULL DEFAULT 'ON_TRACK',
  "status" "GoalStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KeyResult_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "KeyResult_businessId_objectiveId_idx" ON "KeyResult"("businessId","objectiveId");

-- ── GoalCheckIn (append-only) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "GoalCheckIn" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "keyResultId" TEXT NOT NULL,
  "authorEmployeeId" TEXT NOT NULL,
  "previousValue" DECIMAL(18,4) NOT NULL,
  "newValue" DECIMAL(18,4) NOT NULL,
  "confidence" "RagStatus" NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoalCheckIn_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "GoalCheckIn_businessId_keyResultId_createdAt_idx" ON "GoalCheckIn"("businessId","keyResultId","createdAt");

-- ── ObjectiveAlignment ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ObjectiveAlignment" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "childObjectiveId" TEXT NOT NULL,
  "parentObjectiveId" TEXT NOT NULL,
  "alignmentWeight" DECIMAL(5,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ObjectiveAlignment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ObjectiveAlignment_businessId_childObjectiveId_parentObjectiveId_key" ON "ObjectiveAlignment"("businessId","childObjectiveId","parentObjectiveId");
CREATE INDEX IF NOT EXISTS "ObjectiveAlignment_businessId_parentObjectiveId_idx" ON "ObjectiveAlignment"("businessId","parentObjectiveId");

-- ── ReviewTemplate ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ReviewTemplate" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "ratingScaleId" TEXT,
  "sectionsJson" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ReviewTemplate_businessId_idx" ON "ReviewTemplate"("businessId");

-- ── RatingScale ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RatingScale" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "pointsJson" JSONB NOT NULL,
  "allowsHalfPoints" BOOLEAN NOT NULL DEFAULT true,
  "forcedDistributionJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RatingScale_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "RatingScale_businessId_idx" ON "RatingScale"("businessId");

-- ── ReviewResponse ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ReviewResponse" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "reviewInstanceId" TEXT NOT NULL,
  "perspective" "ReviewPerspective" NOT NULL,
  "sectionKey" TEXT NOT NULL,
  "itemKey" TEXT NOT NULL,
  "ratingValue" DECIMAL(4,2),
  "comment" TEXT,
  "authorEmployeeId" TEXT NOT NULL,
  "visibility" "ResponseVisibility" NOT NULL DEFAULT 'SHARED',
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewResponse_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ReviewResponse_businessId_reviewInstanceId_perspective_idx" ON "ReviewResponse"("businessId","reviewInstanceId","perspective");

-- ── PeerFeedbackRequest ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PeerFeedbackRequest" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "reviewInstanceId" TEXT NOT NULL,
  "requestedByEmployeeId" TEXT NOT NULL,
  "raterEmployeeId" TEXT NOT NULL,
  "status" "FeedbackStatus" NOT NULL DEFAULT 'REQUESTED',
  "dueDate" DATE,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PeerFeedbackRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PeerFeedbackRequest_businessId_reviewInstanceId_idx" ON "PeerFeedbackRequest"("businessId","reviewInstanceId");
CREATE INDEX IF NOT EXISTS "PeerFeedbackRequest_businessId_raterEmployeeId_status_idx" ON "PeerFeedbackRequest"("businessId","raterEmployeeId","status");

-- ── PeerFeedbackResponse ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PeerFeedbackResponse" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "ratingsJson" JSONB,
  "narrative" TEXT,
  "isAnonymous" BOOLEAN NOT NULL DEFAULT true,
  "submittedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PeerFeedbackResponse_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PeerFeedbackResponse_requestId_key" ON "PeerFeedbackResponse"("requestId");

-- ── CalibrationSession ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "CalibrationSession" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "cycleId" TEXT NOT NULL,
  "skipLevelEmployeeId" TEXT NOT NULL,
  "status" "CalibrationStatus" NOT NULL DEFAULT 'OPEN',
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CalibrationSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CalibrationSession_businessId_cycleId_idx" ON "CalibrationSession"("businessId","cycleId");

-- ── CalibrationAdjustment (append-only) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "CalibrationAdjustment" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "reviewInstanceId" TEXT NOT NULL,
  "fromRating" DECIMAL(4,2),
  "toRating" DECIMAL(4,2) NOT NULL,
  "reason" TEXT NOT NULL,
  "byEmployeeId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CalibrationAdjustment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CalibrationAdjustment_businessId_sessionId_idx" ON "CalibrationAdjustment"("businessId","sessionId");
CREATE INDEX IF NOT EXISTS "CalibrationAdjustment_businessId_reviewInstanceId_idx" ON "CalibrationAdjustment"("businessId","reviewInstanceId");

-- ── OneOnOne ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "OneOnOne" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "managerEmployeeId" TEXT NOT NULL,
  "employeeEmployeeId" TEXT NOT NULL,
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "agendaJson" JSONB,
  "sharedNotes" TEXT,
  "privateNotes" TEXT,
  "actionItemsJson" JSONB,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OneOnOne_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "OneOnOne_businessId_managerEmployeeId_idx" ON "OneOnOne"("businessId","managerEmployeeId");
CREATE INDEX IF NOT EXISTS "OneOnOne_businessId_employeeEmployeeId_idx" ON "OneOnOne"("businessId","employeeEmployeeId");

-- ── MeritRecommendation ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "MeritRecommendation" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "reviewInstanceId" TEXT NOT NULL,
  "subjectEmployeeId" TEXT NOT NULL,
  "cycleId" TEXT NOT NULL,
  "finalRating" DECIMAL(4,2) NOT NULL,
  "compositeScore" DECIMAL(6,3) NOT NULL,
  "proRationFactor" DECIMAL(5,4) NOT NULL,
  "recommendedPct" DECIMAL(5,2) NOT NULL,
  "status" "MeritStatus" NOT NULL DEFAULT 'PENDING',
  "compensationRevisionId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MeritRecommendation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MeritRecommendation_businessId_reviewInstanceId_key" ON "MeritRecommendation"("businessId","reviewInstanceId");
CREATE INDEX IF NOT EXISTS "MeritRecommendation_businessId_cycleId_status_idx" ON "MeritRecommendation"("businessId","cycleId","status");

-- ── Foreign keys (guarded; ADD CONSTRAINT has no IF NOT EXISTS) ──────────────────
DO $$ BEGIN ALTER TABLE "Objective" ADD CONSTRAINT "Objective_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "Objective" ADD CONSTRAINT "Objective_ownerEmployeeId_fkey" FOREIGN KEY ("ownerEmployeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "Objective" ADD CONSTRAINT "Objective_parentObjectiveId_fkey" FOREIGN KEY ("parentObjectiveId") REFERENCES "Objective"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "Objective" ADD CONSTRAINT "Objective_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "ReviewCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "KeyResult" ADD CONSTRAINT "KeyResult_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "Objective"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "GoalCheckIn" ADD CONSTRAINT "GoalCheckIn_keyResultId_fkey" FOREIGN KEY ("keyResultId") REFERENCES "KeyResult"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "ObjectiveAlignment" ADD CONSTRAINT "ObjectiveAlignment_childObjectiveId_fkey" FOREIGN KEY ("childObjectiveId") REFERENCES "Objective"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "ObjectiveAlignment" ADD CONSTRAINT "ObjectiveAlignment_parentObjectiveId_fkey" FOREIGN KEY ("parentObjectiveId") REFERENCES "Objective"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "ReviewTemplate" ADD CONSTRAINT "ReviewTemplate_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "RatingScale" ADD CONSTRAINT "RatingScale_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "ReviewResponse" ADD CONSTRAINT "ReviewResponse_reviewInstanceId_fkey" FOREIGN KEY ("reviewInstanceId") REFERENCES "PerformanceReview"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "PeerFeedbackRequest" ADD CONSTRAINT "PeerFeedbackRequest_reviewInstanceId_fkey" FOREIGN KEY ("reviewInstanceId") REFERENCES "PerformanceReview"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "PeerFeedbackResponse" ADD CONSTRAINT "PeerFeedbackResponse_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PeerFeedbackRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "CalibrationSession" ADD CONSTRAINT "CalibrationSession_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "ReviewCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "CalibrationAdjustment" ADD CONSTRAINT "CalibrationAdjustment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CalibrationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "CalibrationAdjustment" ADD CONSTRAINT "CalibrationAdjustment_reviewInstanceId_fkey" FOREIGN KEY ("reviewInstanceId") REFERENCES "PerformanceReview"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "OneOnOne" ADD CONSTRAINT "OneOnOne_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "OneOnOne" ADD CONSTRAINT "OneOnOne_managerEmployeeId_fkey" FOREIGN KEY ("managerEmployeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "OneOnOne" ADD CONSTRAINT "OneOnOne_employeeEmployeeId_fkey" FOREIGN KEY ("employeeEmployeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "MeritRecommendation" ADD CONSTRAINT "MeritRecommendation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "MeritRecommendation" ADD CONSTRAINT "MeritRecommendation_reviewInstanceId_fkey" FOREIGN KEY ("reviewInstanceId") REFERENCES "PerformanceReview"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "MeritRecommendation" ADD CONSTRAINT "MeritRecommendation_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "ReviewCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
