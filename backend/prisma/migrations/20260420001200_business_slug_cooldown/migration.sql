-- Business.slugLastChangedAt — timestamp of the last slug change. Used to
-- enforce a 30-day cooldown on slug edits from Admin → Settings (prevents
-- accidental thrash; keeps bookmarks, share links and SEO stable).
-- Nullable: existing rows haven't "changed" yet — first edit is free; the
-- 30-day clock starts from that moment.

ALTER TABLE "Business" ADD COLUMN "slugLastChangedAt" TIMESTAMP(3);
