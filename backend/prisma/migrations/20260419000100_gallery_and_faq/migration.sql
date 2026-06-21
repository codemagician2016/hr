-- Add Gallery + FAQ sections per Design Spec v1.0 (pages 9 and 12)
-- AlterTable
ALTER TABLE "BusinessContent"
  ADD COLUMN "showGallery"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "galleryEyebrow" TEXT,
  ADD COLUMN "galleryTitle"   TEXT,
  ADD COLUMN "gallerySub"     TEXT,
  ADD COLUMN "galleryItems"   TEXT,
  ADD COLUMN "showFaq"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "faqEyebrow"     TEXT,
  ADD COLUMN "faqTitle"       TEXT,
  ADD COLUMN "faqIntro"       TEXT,
  ADD COLUMN "faqItems"       TEXT;
