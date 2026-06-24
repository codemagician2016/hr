-- CreateEnum
CREATE TYPE "ImportKind" AS ENUM ('EMPLOYEE', 'COMPENSATION', 'ATTENDANCE', 'PAYROLL_HISTORY', 'REIMBURSEMENT');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'PARSED', 'VALIDATED', 'DRY_RUN_OK', 'COMMITTING', 'COMMITTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('PARSED', 'PASS', 'WARN', 'ERROR', 'COMMITTED', 'SKIPPED', 'FAILED');

-- AlterEnum
ALTER TYPE "PayRunType" ADD VALUE 'MIGRATED';

-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "importJobId" TEXT;

-- AlterTable
ALTER TABLE "AttendancePayInput" ADD COLUMN     "importJobId" TEXT;

-- AlterTable
ALTER TABLE "ExpenseClaim" ADD COLUMN     "importJobId" TEXT;

-- AlterTable
ALTER TABLE "PayRun" ADD COLUMN     "importJobId" TEXT;

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "kind" "ImportKind" NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "fileName" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "mimeType" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "mappingJson" JSONB,
    "optionsJson" JSONB,
    "passCount" INTEGER NOT NULL DEFAULT 0,
    "warnCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "committedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "previewJson" JSONB,
    "uploadedBy" TEXT NOT NULL,
    "committedBy" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validatedAt" TIMESTAMP(3),
    "committedAt" TIMESTAMP(3),
    "failedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "importJobId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "rawJson" JSONB NOT NULL,
    "parsedJson" JSONB NOT NULL,
    "naturalKey" TEXT,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'PARSED',
    "findingsJson" JSONB,
    "resultJson" JSONB,
    "targetType" TEXT,
    "targetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportJob_businessId_kind_status_idx" ON "ImportJob"("businessId", "kind", "status");

-- CreateIndex
CREATE INDEX "ImportJob_businessId_status_idx" ON "ImportJob"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ImportJob_businessId_kind_fileHash_key" ON "ImportJob"("businessId", "kind", "fileHash");

-- CreateIndex
CREATE INDEX "ImportRow_businessId_importJobId_status_idx" ON "ImportRow"("businessId", "importJobId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_importJobId_naturalKey_key" ON "ImportRow"("importJobId", "naturalKey");

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "ImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

