-- AlterTable
ALTER TABLE "Business"
  ADD COLUMN "reviewRequestEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "reviewRequestLink" TEXT;
