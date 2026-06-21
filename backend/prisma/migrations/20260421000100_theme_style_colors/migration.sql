-- Theme expansion (Phase 1 · April 2026).
-- The single `theme` column used to carry a bundled "look + content" identity.
-- We split it into three dimensions so 40 professions × 10 styles × custom
-- colour overrides can compose freely:
--   theme        — profession key (dental / barber / legal / yoga / …)
--   themeStyle   — visual variant (light / dark / elegant / matte / …)
--   themeColors  — optional JSON { primary, accent, surface } (hex)
-- Existing subscriptions all get themeStyle='light' and no colour overrides,
-- which means "use the profession's default visuals" — no user-visible change
-- until they opt in.

ALTER TABLE "Subscription" ADD COLUMN "themeStyle"  TEXT NOT NULL DEFAULT 'light';
ALTER TABLE "Subscription" ADD COLUMN "themeColors" TEXT;
