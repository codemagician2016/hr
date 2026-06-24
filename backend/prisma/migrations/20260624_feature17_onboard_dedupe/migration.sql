-- Feature 17 — Onboard-by-CTC idempotency hardening (review HIGH finding).
--
-- The onboard-by-CTC dedupe was an app-level pre-check (prisma.employee.findFirst run
-- BEFORE the $transaction) with NO backing DB constraint — a TOCTOU race: two
-- concurrent identical POSTs both passed the check and both inserted, producing a
-- DUPLICATE Employee + duplicate HIRE CompensationRevision (double pay). A null-email
-- hire skipped the check entirely, so even a sequential retry double-created.
--
-- This migration adds the DB-level natural-key uniqueness the controller now relies
-- on. The Employee.create runs inside the tx; a P2002 on this index is translated to
-- 409 ALREADY_ONBOARDED returning the existing row (idempotent), so concurrent/retried
-- onboards converge to ONE employee.
--
-- ADDITIVE + SAFE on a live tenant:
--   * a PARTIAL unique index (only WHERE workEmail IS NOT NULL AND deletedAt IS NULL),
--     so it never constrains null-email or soft-deleted rows — no backfill, no NOT NULL,
--     no change to existing columns;
--   * IF NOT EXISTS keeps it idempotent against a previously `db push`-ed schema;
--   * the (businessId, code) unique already on Employee backs the code/idempotencyKey
--     path for null-email hires — no new column needed.
--
-- NOTE: Prisma's @@unique cannot express a partial (WHERE) predicate, so this index is
-- managed by this raw migration only (intentionally NOT declared in schema.prisma).

CREATE UNIQUE INDEX IF NOT EXISTS "Employee_businessId_workEmail_hireDate_active_key"
  ON "Employee" ("businessId", "workEmail", "hireDate")
  WHERE "workEmail" IS NOT NULL AND "deletedAt" IS NULL;
