-- Per-branch holidays: a holiday can now be scoped to one branch
-- (locationId) so different cities observe different public holidays.
-- null = applies to all branches (business-wide), preserving existing rows.
ALTER TABLE "BusinessHoliday" ADD COLUMN "locationId" TEXT;

-- Replace the business+date unique with business+location+date so two
-- branches can both close on the same calendar date.
ALTER TABLE "BusinessHoliday" DROP CONSTRAINT IF EXISTS "BusinessHoliday_businessId_date_key";
ALTER TABLE "BusinessHoliday"
  ADD CONSTRAINT "BusinessHoliday_businessId_locationId_date_key" UNIQUE ("businessId", "locationId", "date");

CREATE INDEX IF NOT EXISTS "BusinessHoliday_businessId_locationId_idx"
  ON "BusinessHoliday" ("businessId", "locationId");

-- Deleting a branch deletes its branch-specific holidays (business-wide
-- holidays have null locationId and are unaffected).
ALTER TABLE "BusinessHoliday"
  ADD CONSTRAINT "BusinessHoliday_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
