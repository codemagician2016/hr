-- Sprint 3.3 — Pages CMS v2 (drag-to-nest navbar). Additive only:
--   1. New PagePlacement enum (TOP / DROPDOWN / FOOTER / HIDDEN)
--   2. BusinessPage.placement (defaults DROPDOWN — matches legacy behaviour)
--   3. BusinessPage.iconKey (nullable, for admin/nav-manager UI hints)
--   4. Business.siteNav (nullable JSON — the admin's drag-to-nest tree)
-- No backfill needed: existing rows pick up the DROPDOWN default, which
-- preserves how the storefront groups pages by parentNav today.

CREATE TYPE "PagePlacement" AS ENUM ('TOP', 'DROPDOWN', 'FOOTER', 'HIDDEN');

ALTER TABLE "BusinessPage"
  ADD COLUMN "placement" "PagePlacement" NOT NULL DEFAULT 'DROPDOWN',
  ADD COLUMN "iconKey"   TEXT;

ALTER TABLE "Business"
  ADD COLUMN "siteNav" JSONB;
