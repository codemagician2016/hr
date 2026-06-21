-- AlterTable
-- New JSON fields that decouple homepage Services + Team rendering from
-- the booking system's Service[] + User[] tables. Both fields are
-- nullable strings holding a JSON array; matches the existing pattern
-- already used by testimonials / statsItems / pricingTiers.
ALTER TABLE "BusinessContent"
  ADD COLUMN "cmsServices" TEXT,
  ADD COLUMN "cmsTeam"     TEXT;
