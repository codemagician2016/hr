-- Add page-LAYOUT columns to Subscription. Decoupled from the theme /
-- themeStyle / themeColors columns: those control colour + typography
-- tokens, these control which section variants render and in what
-- composition. NULL designPreset = "classic" (the existing layout, no
-- visual change for tenants who haven't picked a new one).
ALTER TABLE "Subscription"
  ADD COLUMN "designPreset"     TEXT,
  ADD COLUMN "sectionVariants"  TEXT;
