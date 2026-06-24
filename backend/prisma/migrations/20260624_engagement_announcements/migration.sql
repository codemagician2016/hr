-- Engagement (Cycle 1) — Announcements / company news feed + read receipts.
--
-- FULLY ADDITIVE + SAFE on a live tenant: three new enums + two new tables
-- (Announcement, AnnouncementRead). No existing column/table/enum is touched, no
-- backfill, no NOT NULL on existing rows. `IF NOT EXISTS` guards keep it idempotent
-- against a schema that was previously `db push`-ed. Tenant isolation is carried by
-- businessId on every row (+ index); the audience id-arrays are denormalised so the
-- ESS feed membership test is a single in-memory intersection (no per-render join).
--
-- This migration is intentionally hand-written (NOT `prisma migrate diff` output)
-- so it contains ONLY the announcements delta — the repo's migrations-history has
-- pre-existing `db push` drift (updatedAt DROP DEFAULT, unrelated enum adds) that a
-- diff would otherwise sweep in.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "AnnouncementCategory" AS ENUM ('NEWS', 'POLICY', 'EVENT', 'HOLIDAY', 'CELEBRATION', 'GENERAL');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "AnnouncementAudienceScope" AS ENUM ('ALL', 'ENTITY', 'DEPARTMENT', 'SPECIFIC');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "AnnouncementStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Announcement" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "authorUserId" TEXT NOT NULL,
  "authorName" TEXT,
  "title" TEXT NOT NULL,
  "bodyRichText" TEXT NOT NULL,
  "category" "AnnouncementCategory" NOT NULL DEFAULT 'NEWS',
  "audienceScope" "AnnouncementAudienceScope" NOT NULL DEFAULT 'ALL',
  "audienceEntityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "audienceDeptIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "audienceEmployeeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "pinned" BOOLEAN NOT NULL DEFAULT false,
  "status" "AnnouncementStatus" NOT NULL DEFAULT 'DRAFT',
  "publishedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "archivedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AnnouncementRead" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "announcementId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnnouncementRead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Announcement_businessId_status_publishedAt_idx" ON "Announcement"("businessId", "status", "publishedAt");
CREATE INDEX IF NOT EXISTS "Announcement_businessId_status_pinned_publishedAt_idx" ON "Announcement"("businessId", "status", "pinned", "publishedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "AnnouncementRead_announcementId_employeeId_key" ON "AnnouncementRead"("announcementId", "employeeId");
CREATE INDEX IF NOT EXISTS "AnnouncementRead_businessId_employeeId_idx" ON "AnnouncementRead"("businessId", "employeeId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "AnnouncementRead" ADD CONSTRAINT "AnnouncementRead_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "AnnouncementRead" ADD CONSTRAINT "AnnouncementRead_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "AnnouncementRead" ADD CONSTRAINT "AnnouncementRead_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
