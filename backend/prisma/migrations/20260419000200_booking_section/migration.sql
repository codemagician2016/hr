-- Add Booking section per Design Spec v1.0 (page 11) — "The payoff."
-- AlterTable
ALTER TABLE "BusinessContent"
  ADD COLUMN "showBooking"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "bookingEyebrow" TEXT,
  ADD COLUMN "bookingTitle"   TEXT,
  ADD COLUMN "bookingSub"     TEXT,
  ADD COLUMN "bookingCta"     TEXT;
