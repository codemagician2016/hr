-- Feature 11 follow-up — ExpenseClaim.claimNumber per-tenant uniqueness.
--
-- WHY: claimNumber (EXP-####) is a human reference stamped onto payment refs / payslips,
-- yet it had NO DB unique constraint. Two minters race to mint it — the legacy operator
-- create (read-max nextClaimNumber, controllers/expenses.controller.js) and the ESS path
-- (atomic allocateCode, scope 'EXP'). With no backstop: (a) the legacy P2002 retry could
-- never fire (no unique to violate), so two concurrent legacy creates persist the SAME
-- EXP-####; (b) the allocateCode NumberSequence starts at nextValue:1 and collides with
-- any pre-existing legacy EXP-0001..EXP-NNNN. Duplicate human claim ids = a money/audit
-- integrity hole. This migration closes BOTH:
--
--   1. Seed the EXP NumberSequence nextValue from the current max EXP-#### per business,
--      so the atomic allocator continues ABOVE existing legacy claims (never restarts at 1).
--   2. Add a unique index on (businessId, claimNumber) — matching Prisma's
--      @@unique([businessId, claimNumber]) exactly (same name, non-partial). On Postgres a
--      composite unique treats every NULL as DISTINCT, so legacy/in-flight NULL claimNumbers
--      coexist freely while any duplicate non-null EXP-#### is rejected — and the existing
--      P2002 retry loops finally have a constraint to retry on. (A partial WHERE
--      "claimNumber" IS NOT NULL would behave identically here but drift from Prisma's
--      generated DDL, so the plain form is used to keep schema↔DB aligned.)
--
-- ADDITIVE + idempotent (IF guards / ON CONFLICT / DO blocks): applies cleanly to a fresh
-- DB, to a `prisma db push` DB (hr_test), and re-runs safely. No data dropped or rewritten.

-- ── 1. Seed / advance the EXP NumberSequence so allocateCode mints ABOVE legacy claims ──
-- For every tenant that already holds EXP-#### claims, compute max(suffix)+1 and either
-- create the (businessId, EXP, NULL, NULL) sequence row at that value or bump an existing
-- row UP to it (GREATEST → never lowers a counter that already ran ahead).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT "businessId",
           MAX( (substring("claimNumber" from '^EXP-([0-9]+)$'))::int ) AS maxnum
    FROM "ExpenseClaim"
    WHERE "claimNumber" ~ '^EXP-[0-9]+$'
    GROUP BY "businessId"
  LOOP
    IF EXISTS (
      SELECT 1 FROM "NumberSequence"
      WHERE "businessId" = r."businessId" AND "scope" = 'EXP'
        AND "entityId" IS NULL AND "periodKey" IS NULL
    ) THEN
      UPDATE "NumberSequence"
        SET "nextValue" = GREATEST("nextValue", r.maxnum + 1)
        WHERE "businessId" = r."businessId" AND "scope" = 'EXP'
          AND "entityId" IS NULL AND "periodKey" IS NULL;
    ELSE
      INSERT INTO "NumberSequence" ("id", "businessId", "entityId", "scope", "prefix", "nextValue", "padding", "periodKey", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, r."businessId", NULL, 'EXP', 'EXP-', r.maxnum + 1, 4, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    END IF;
  END LOOP;
END $$;

-- ── 2. Unique index on (businessId, claimNumber) ───────────────────────────────────────
-- Name + shape match Prisma's @@unique([businessId, claimNumber]) so client/types and DB
-- agree (no drift). Postgres treats NULLs as distinct, so legacy/in-flight NULL rows coexist.
CREATE UNIQUE INDEX IF NOT EXISTS "ExpenseClaim_businessId_claimNumber_key"
  ON "ExpenseClaim" ("businessId", "claimNumber");
