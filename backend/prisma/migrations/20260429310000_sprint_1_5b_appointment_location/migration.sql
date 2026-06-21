-- Sprint 1.5b — link Appointment → BusinessLocation so a multi-location
-- business can record which branch each booking is for. NULL = legacy
-- single-location business OR booking pre-dates multi-location feature.

ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "locationId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Appointment_locationId_fkey'
  ) THEN
    ALTER TABLE "Appointment"
      ADD CONSTRAINT "Appointment_locationId_fkey"
      FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "Appointment_locationId_idx" ON "Appointment"("locationId");
