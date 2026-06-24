-- Cycle 1 (engagement review fix) — Announcement re-publish idempotency.
-- ADDITIVE only: one nullable timestamp column "notifiedAt" on "Announcement". It is
-- stamped the FIRST time an announcement goes live (DRAFT/ARCHIVED → PUBLISHED while
-- live) and is the idempotency guard so a re-save / re-publish of an already-PUBLISHED
-- (already-notified) announcement does NOT re-blast its audience. NULL = never fanned
-- out. No NOT NULL, no default, no backfill — safe to apply on a live tenant. IF NOT
-- EXISTS keeps it idempotent against a schema that was previously `db push`-ed.
--
-- Existing rows (already published before this fix) get NULL. They will NOT be re-blasted
-- on a future re-publish because the guard ALSO checks the prior status: an already-
-- PUBLISHED row is never first-publish, so the legacy NULL can never trigger a late blast.

ALTER TABLE "Announcement" ADD COLUMN IF NOT EXISTS "notifiedAt" TIMESTAMP(3);
