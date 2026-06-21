-- Nav label overrides for the three new sections (Gallery, FAQ, Booking).
-- These double as the editable tab labels in the content editor.
-- AlterTable
ALTER TABLE "BusinessContent"
  ADD COLUMN "navGalleryLabel" TEXT,
  ADD COLUMN "navBookingLabel" TEXT,
  ADD COLUMN "navFaqLabel"     TEXT;
