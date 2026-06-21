-- Structured location on Business: country (ISO-3166-1 alpha-2) + state.
-- Needed for timezone resolution, regional pricing fallback, and address
-- formatting on the public site. Nullable so existing rows stay valid;
-- new/updated rows collect these values via the onboarding and Settings
-- forms (which make them required at the UI layer).
--
-- Backfill for existing businesses: default country='NZ' / state='Auckland'
-- per 2026-04-20 owner request, so the one live tenant (john4) has a valid
-- timezone immediately without waiting for a manual Settings save.

ALTER TABLE "Business"
  ADD COLUMN "country" TEXT,
  ADD COLUMN "state"   TEXT;

UPDATE "Business" SET "country" = 'NZ'       WHERE "country" IS NULL;
UPDATE "Business" SET "state"   = 'Auckland' WHERE "state"   IS NULL;
