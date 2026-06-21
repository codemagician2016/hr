-- Doctor v2 (Phase 4) — section engine: store the owner's hidden storefront
-- sections (JSON array of keys) on BusinessContent. Additive + nullable.
ALTER TABLE "BusinessContent" ADD COLUMN IF NOT EXISTS "hiddenSections" TEXT;
