-- Screening forms: a FILE question kind, and "Other (please specify)" options.
-- PURELY ADDITIVE — one new enum value and two new NOT NULL columns that both
-- carry a default, so existing rows and existing forms are unaffected.
--
-- IF NOT EXISTS / guarded enum add keeps this idempotent against schemas that
-- already had `prisma db push` run against them (staging + hr_test), matching
-- the idiom used by the feature15 and setup_state migrations.

-- FILE: the candidate uploads a document; the answer stores its URL. Never
-- knockout- or points-scored.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'ScreeningKind' AND e.enumlabel = 'FILE'
  ) THEN
    ALTER TYPE "ScreeningKind" ADD VALUE 'FILE';
  END IF;
END$$;

-- allowsFreeText: selecting the option reveals a text box. Scoring still keys off
-- `value`, so a free-text answer cannot smuggle points.
ALTER TABLE "ScreeningOption"                ADD COLUMN IF NOT EXISTS "allowsFreeText" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ScreeningFormTemplateOption"    ADD COLUMN IF NOT EXISTS "allowsFreeText" BOOLEAN NOT NULL DEFAULT false;

-- The candidate's "Other (please specify)" text. Stored beside answerValue, never
-- inside it: scoring canonicalises answerValue, so reshaping it into an object
-- would silently break knockout matching and points.
ALTER TABLE "ScreeningAnswer" ADD COLUMN IF NOT EXISTS "freeText" TEXT;
