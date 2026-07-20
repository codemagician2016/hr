-- Feature 39 — tenant-defined letter CATEGORIES (e.g. "Bank Resolution") for
-- grouping/filtering templates + issued letters, and a REUSABLE signature/stamp
-- asset library so HR uploads a signature or company seal once and reuses it on
-- every future template. All additive.
CREATE TABLE "LetterCategoryTag" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LetterCategoryTag_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LetterCategoryTag_businessId_name_key" ON "LetterCategoryTag"("businessId", "name");
CREATE INDEX "LetterCategoryTag_businessId_isActive_idx" ON "LetterCategoryTag"("businessId", "isActive");

CREATE TABLE "LetterAsset" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "imageUrl" TEXT NOT NULL,
  "imageHash" TEXT,
  "mimeType" TEXT,
  "sizeBytes" INTEGER,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LetterAsset_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LetterAsset_businessId_kind_isActive_idx" ON "LetterAsset"("businessId", "kind", "isActive");

ALTER TABLE "LetterTemplate"
  ADD COLUMN "categoryId" TEXT,
  ADD COLUMN "signatureAssetId" TEXT,
  ADD COLUMN "stampAssetId" TEXT,
  ADD COLUMN "stampBoxJson" JSONB;
CREATE INDEX "LetterTemplate_businessId_categoryId_idx" ON "LetterTemplate"("businessId", "categoryId");

ALTER TABLE "IssuedLetter" ADD COLUMN "categoryId" TEXT;

ALTER TABLE "LetterCategoryTag" ADD CONSTRAINT "LetterCategoryTag_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LetterAsset" ADD CONSTRAINT "LetterAsset_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LetterTemplate" ADD CONSTRAINT "LetterTemplate_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "LetterCategoryTag"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LetterTemplate" ADD CONSTRAINT "LetterTemplate_signatureAssetId_fkey" FOREIGN KEY ("signatureAssetId") REFERENCES "LetterAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LetterTemplate" ADD CONSTRAINT "LetterTemplate_stampAssetId_fkey" FOREIGN KEY ("stampAssetId") REFERENCES "LetterAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IssuedLetter" ADD CONSTRAINT "IssuedLetter_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "LetterCategoryTag"("id") ON DELETE SET NULL ON UPDATE CASCADE;
