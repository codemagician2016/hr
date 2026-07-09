-- Feature 38 — candidate PORTAL accounts (passwordless magic-link) + rich profile
-- (education / work experience / skills) + per-application resume snapshot. Additive.
ALTER TABLE "Candidate"
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "lastLoginAt" TIMESTAMP(3),
  ADD COLUMN "headline" TEXT,
  ADD COLUMN "location" TEXT,
  ADD COLUMN "totalExperienceMonths" INTEGER;

ALTER TABLE "Application" ADD COLUMN "resumeUrl" TEXT;

ALTER TYPE "ApplicationSource" ADD VALUE IF NOT EXISTS 'CAREER_PORTAL';

CREATE TABLE "CandidateEducation" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "institution" TEXT NOT NULL,
  "fieldOfStudy" TEXT,
  "startYear" INTEGER,
  "endYear" INTEGER,
  "grade" TEXT,
  "isHighest" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CandidateEducation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CandidateEducation_candidateId_idx" ON "CandidateEducation"("candidateId");

CREATE TABLE "CandidateExperience" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "company" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "employmentType" TEXT,
  "location" TEXT,
  "startDate" TIMESTAMP(3),
  "endDate" TIMESTAMP(3),
  "isCurrent" BOOLEAN NOT NULL DEFAULT false,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CandidateExperience_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CandidateExperience_candidateId_idx" ON "CandidateExperience"("candidateId");

CREATE TABLE "CandidateSkill" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "level" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CandidateSkill_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CandidateSkill_candidateId_idx" ON "CandidateSkill"("candidateId");

ALTER TABLE "CandidateEducation" ADD CONSTRAINT "CandidateEducation_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CandidateExperience" ADD CONSTRAINT "CandidateExperience_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CandidateSkill" ADD CONSTRAINT "CandidateSkill_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
