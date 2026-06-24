-- Cycle 1 — ESS Company Directory (searchable, paginated colleague directory).
-- ADDITIVE only: ONE new boolean column on "Employee" with a default of false, so the
-- colleague-directory opt-out for the OPTIONAL shareable field (work/office phone) has a
-- home. No NOT NULL backfill risk (DEFAULT false covers every existing row), no new
-- table, no dropped column — safe to apply on a live tenant (mirrors the additive
-- migrations of feature13/feature19). IF NOT EXISTS keeps it idempotent against a schema
-- that was previously `db push`-ed (the hr_test schema was bootstrapped that way).
--
-- directoryHidePhone = true  → the colleague directory hides this employee's office
-- phone from OTHER employees. It NEVER hides their name/designation/department/work
-- email (the person stays findable) and NEVER affects HR/operator reads. The directory
-- already exposes only work/professional fields and honours F13 field governance; this
-- flag is the per-employee opt-out layered on top for the one optional contact field.

ALTER TABLE "Employee"
  ADD COLUMN IF NOT EXISTS "directoryHidePhone" BOOLEAN NOT NULL DEFAULT false;
