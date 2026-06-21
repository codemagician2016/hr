-- Per-day lunch / mid-day break on StaffSchedule. null on either side =
-- no break for that day. Excluded from the bookable-slot calculator.
ALTER TABLE "StaffSchedule"
  ADD COLUMN "lunchStart" TEXT,
  ADD COLUMN "lunchEnd"   TEXT;
