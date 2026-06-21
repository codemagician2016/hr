-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "themeChangeMonthCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "themeChangedAt" TIMESTAMP(3);
