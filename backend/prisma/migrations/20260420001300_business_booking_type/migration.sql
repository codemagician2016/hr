-- Business.bookingType — chooses how customers pay:
--   POSTPAID (default) — customer pays at the venue after the service
--   PREPAID            — customer pays upfront at booking time
-- Kept as a TEXT with a default + CHECK so we don't need a Postgres enum
-- migration dance. Existing rows backfill to POSTPAID automatically.

ALTER TABLE "Business"
  ADD COLUMN "bookingType" TEXT NOT NULL DEFAULT 'POSTPAID';

ALTER TABLE "Business"
  ADD CONSTRAINT "Business_bookingType_check" CHECK ("bookingType" IN ('PREPAID', 'POSTPAID'));
