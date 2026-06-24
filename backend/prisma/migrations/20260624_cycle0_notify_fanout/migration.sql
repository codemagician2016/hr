-- Cycle 0 — Notification fan-out. Additive only. Hand-authored to be idempotent so
-- it applies cleanly to the isolated hr_test schema (bootstrapped via `prisma db push`)
-- as well as a clean migrate-deploy on the box. Uses ADD COLUMN IF NOT EXISTS.
--
-- Per-employee channel preferences + opt-out for HR-event notifications. NULL = the
-- tenant/router defaults apply (no behaviour change for existing rows). This narrows
-- the existing budget/opt-out cascade; it never bypasses it.
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "notifyPrefs" JSONB;
