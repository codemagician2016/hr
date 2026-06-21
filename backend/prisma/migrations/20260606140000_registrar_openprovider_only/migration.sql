-- Migrate the Registrar enum to Openprovider-only.
--
-- The domain reseller now uses a single registrar (Openprovider REST API);
-- the ResellerClub + 1API/HEXONET adapters were removed. The enum previously
-- allowed ('RESELLER_CLUB', '_1API', 'BYOD') but the application now writes
-- 'OPENPROVIDER', which Postgres would reject as an invalid enum value.
--
-- Recreate the type as ('OPENPROVIDER', 'BYOD') and remap any existing rows:
-- BYOD stays BYOD; every other legacy registrar value collapses to OPENPROVIDER
-- (there should be no live RESELLER_CLUB/_1API rows yet, but this is safe if any
-- exist). Both columns are NOT NULL with no default, so no default juggling.

CREATE TYPE "Registrar_new" AS ENUM ('OPENPROVIDER', 'BYOD');

ALTER TABLE "Domain"
  ALTER COLUMN "registrar" TYPE "Registrar_new"
  USING (CASE WHEN "registrar"::text = 'BYOD' THEN 'BYOD' ELSE 'OPENPROVIDER' END::"Registrar_new");

ALTER TABLE "DomainPricing"
  ALTER COLUMN "registrar" TYPE "Registrar_new"
  USING (CASE WHEN "registrar"::text = 'BYOD' THEN 'BYOD' ELSE 'OPENPROVIDER' END::"Registrar_new");

ALTER TYPE "Registrar" RENAME TO "Registrar_old";
ALTER TYPE "Registrar_new" RENAME TO "Registrar";
DROP TYPE "Registrar_old";
