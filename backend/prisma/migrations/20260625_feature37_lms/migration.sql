-- CreateEnum
CREATE TYPE "LearningCategory" AS ENUM ('POSH', 'SAFETY', 'COMPLIANCE', 'ONBOARDING', 'SKILL', 'CODE_OF_CONDUCT', 'GENERAL');

-- CreateEnum
CREATE TYPE "CourseStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CompletionRule" AS ENUM ('ALL_LESSONS', 'QUIZ_PASS', 'BOTH');

-- CreateEnum
CREATE TYPE "LessonKind" AS ENUM ('VIDEO', 'DOCUMENT', 'LINK', 'QUIZ', 'SCORM');

-- CreateEnum
CREATE TYPE "QuestionKind" AS ENUM ('SINGLE', 'MULTI', 'TRUE_FALSE');

-- CreateEnum
CREATE TYPE "LearningAudienceScope" AS ENUM ('ALL', 'ENTITY', 'DEPARTMENT', 'ROLE', 'SPECIFIC');

-- CreateEnum
CREATE TYPE "RecurrenceRule" AS ENUM ('NONE', 'ANNUAL', 'HALF_YEARLY', 'QUARTERLY');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'WAIVED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "LessonProgressStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED');

-- AlterEnum — Feature 37 LMS certificate lands in the ESS document vault + the
-- letters register. Additive enum values; ADD VALUE IF NOT EXISTS is idempotent and
-- safe to re-run (matches the house convention, e.g. feature28 biometric).
ALTER TYPE "DocumentCategory" ADD VALUE IF NOT EXISTS 'TRAINING_CERTIFICATE';

-- AlterEnum
ALTER TYPE "LetterCategory" ADD VALUE IF NOT EXISTS 'LMS_CERTIFICATE';

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "LearningCategory" NOT NULL DEFAULT 'GENERAL',
    "thumbnailUrl" TEXT,
    "estMinutes" INTEGER,
    "passThreshold" INTEGER DEFAULT 70,
    "completionRule" "CompletionRule" NOT NULL DEFAULT 'ALL_LESSONS',
    "certificateEnabled" BOOLEAN NOT NULL DEFAULT true,
    "certificateTemplateId" TEXT,
    "status" "CourseStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseModule" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CourseModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lesson" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "LessonKind" NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "contentUrl" TEXT,
    "contentText" TEXT,
    "durationSec" INTEGER,
    "minWatchPct" INTEGER DEFAULT 90,
    "estMinutes" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Lesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quiz" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "passThreshold" INTEGER NOT NULL DEFAULT 70,
    "maxAttempts" INTEGER DEFAULT 3,
    "shuffle" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Quiz_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizQuestion" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "quizId" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "prompt" TEXT NOT NULL,
    "kind" "QuestionKind" NOT NULL DEFAULT 'SINGLE',
    "optionsJson" JSONB NOT NULL,
    "correctOptionIds" TEXT[],
    "points" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "QuizQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseAssignment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "audienceScope" "LearningAudienceScope" NOT NULL DEFAULT 'ALL',
    "audienceEntityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "audienceDeptIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "audienceRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "audienceEmployeeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isMandatory" BOOLEAN NOT NULL DEFAULT true,
    "dueInDays" INTEGER,
    "dueOn" DATE,
    "recurrence" "RecurrenceRule" NOT NULL DEFAULT 'NONE',
    "newJoinerRule" BOOLEAN NOT NULL DEFAULT false,
    "newJoinerWithinDays" INTEGER DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CourseAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "employeeId" TEXT NOT NULL,
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "cycleKey" TEXT NOT NULL,
    "progressPct" INTEGER NOT NULL DEFAULT 0,
    "certificateLetterId" TEXT,
    "waivedReason" TEXT,
    "waivedBy" TEXT,
    "lastReminderStage" TEXT,
    "lastReminderAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonProgress" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "status" "LessonProgressStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "lastPositionSec" INTEGER NOT NULL DEFAULT 0,
    "watchedPct" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LessonProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizAttempt" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "quizId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL DEFAULT 1,
    "answersJson" JSONB NOT NULL,
    "scorePct" INTEGER NOT NULL DEFAULT 0,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningCertificate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "issuedLetterId" TEXT NOT NULL,
    "employeeDocumentId" TEXT,
    "referenceNo" TEXT NOT NULL,
    "cycleKey" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearningCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Course_businessId_status_category_idx" ON "Course"("businessId", "status", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Course_businessId_code_key" ON "Course"("businessId", "code");

-- CreateIndex
CREATE INDEX "CourseModule_businessId_courseId_orderIndex_idx" ON "CourseModule"("businessId", "courseId", "orderIndex");

-- CreateIndex
CREATE INDEX "Lesson_businessId_courseId_orderIndex_idx" ON "Lesson"("businessId", "courseId", "orderIndex");

-- CreateIndex
CREATE INDEX "Lesson_businessId_moduleId_orderIndex_idx" ON "Lesson"("businessId", "moduleId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Quiz_lessonId_key" ON "Quiz"("lessonId");

-- CreateIndex
CREATE INDEX "Quiz_businessId_lessonId_idx" ON "Quiz"("businessId", "lessonId");

-- CreateIndex
CREATE INDEX "QuizQuestion_businessId_quizId_orderIndex_idx" ON "QuizQuestion"("businessId", "quizId", "orderIndex");

-- CreateIndex
CREATE INDEX "CourseAssignment_businessId_courseId_active_idx" ON "CourseAssignment"("businessId", "courseId", "active");

-- CreateIndex
CREATE INDEX "CourseAssignment_businessId_newJoinerRule_active_idx" ON "CourseAssignment"("businessId", "newJoinerRule", "active");

-- CreateIndex
CREATE INDEX "Enrollment_businessId_employeeId_status_idx" ON "Enrollment"("businessId", "employeeId", "status");

-- CreateIndex
CREATE INDEX "Enrollment_businessId_courseId_status_idx" ON "Enrollment"("businessId", "courseId", "status");

-- CreateIndex
CREATE INDEX "Enrollment_businessId_status_dueAt_idx" ON "Enrollment"("businessId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "Enrollment_businessId_employeeId_courseId_cycleKey_key" ON "Enrollment"("businessId", "employeeId", "courseId", "cycleKey");

-- CreateIndex
CREATE INDEX "LessonProgress_businessId_enrollmentId_status_idx" ON "LessonProgress"("businessId", "enrollmentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LessonProgress_businessId_enrollmentId_lessonId_key" ON "LessonProgress"("businessId", "enrollmentId", "lessonId");

-- CreateIndex
CREATE INDEX "QuizAttempt_businessId_enrollmentId_quizId_idx" ON "QuizAttempt"("businessId", "enrollmentId", "quizId");

-- CreateIndex
CREATE UNIQUE INDEX "QuizAttempt_businessId_enrollmentId_quizId_attemptNo_key" ON "QuizAttempt"("businessId", "enrollmentId", "quizId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "LearningCertificate_enrollmentId_key" ON "LearningCertificate"("enrollmentId");

-- CreateIndex
CREATE INDEX "LearningCertificate_businessId_employeeId_idx" ON "LearningCertificate"("businessId", "employeeId");

-- CreateIndex
CREATE INDEX "LearningCertificate_businessId_courseId_idx" ON "LearningCertificate"("businessId", "courseId");

-- AddForeignKey
ALTER TABLE "Course" ADD CONSTRAINT "Course_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseModule" ADD CONSTRAINT "CourseModule_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseModule" ADD CONSTRAINT "CourseModule_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "CourseModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quiz" ADD CONSTRAINT "Quiz_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quiz" ADD CONSTRAINT "Quiz_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizQuestion" ADD CONSTRAINT "QuizQuestion_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizQuestion" ADD CONSTRAINT "QuizQuestion_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseAssignment" ADD CONSTRAINT "CourseAssignment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseAssignment" ADD CONSTRAINT "CourseAssignment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "CourseAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonProgress" ADD CONSTRAINT "LessonProgress_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonProgress" ADD CONSTRAINT "LessonProgress_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonProgress" ADD CONSTRAINT "LessonProgress_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningCertificate" ADD CONSTRAINT "LearningCertificate_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningCertificate" ADD CONSTRAINT "LearningCertificate_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

