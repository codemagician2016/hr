-- Sprint 1.6b — link User → BusinessRole so per-staff custom permissions
-- can be enforced. NULL = fall back to legacy `User.role` enum.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "businessRoleId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'User_businessRoleId_fkey'
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT "User_businessRoleId_fkey"
      FOREIGN KEY ("businessRoleId") REFERENCES "BusinessRole"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "User_businessRoleId_idx" ON "User"("businessRoleId");
