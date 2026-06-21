-- Hero trust badges: three editable short phrases shown below the hero CTA
-- (e.g. "Same-day appointments"). Defaults live in themes.js; these columns
-- let business owners override or hide them.
-- AlterTable
ALTER TABLE "BusinessContent"
  ADD COLUMN "heroTrust1"    TEXT,
  ADD COLUMN "heroTrust2"    TEXT,
  ADD COLUMN "heroTrust3"    TEXT,
  ADD COLUMN "showHeroTrust" BOOLEAN NOT NULL DEFAULT true;
