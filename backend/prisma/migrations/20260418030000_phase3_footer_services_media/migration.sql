-- AlterTable
ALTER TABLE "BusinessContent" ADD COLUMN "footerCopyright" TEXT,
ADD COLUMN "footerDescription" TEXT,
ADD COLUMN "servicesImageUrl" TEXT,
ADD COLUMN "showFooter" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "showFooterContact" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "showFooterQuickLinks" BOOLEAN NOT NULL DEFAULT true;
