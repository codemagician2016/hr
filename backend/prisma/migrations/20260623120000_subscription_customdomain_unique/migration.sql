-- Feature 3 security fix: Subscription.customDomain must be globally unique so a
-- domain/subdomain host can never be bound to two tenants (squat / double-bind).
--
-- Step 1 — de-dup: if any non-NULL customDomain value is held by more than one
-- row, keep it on the most-recently-updated row and NULL it on the rest. In
-- practice there should be none beyond the seed 'demo' tenant; this is a safety
-- net so the unique index can be created on dirty data. Postgres allows multiple
-- NULLs, so tenants without a domain are unaffected.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "customDomain"
      ORDER BY "updatedAt" DESC NULLS LAST, "id" DESC
    ) AS rn
  FROM "Subscription"
  WHERE "customDomain" IS NOT NULL
)
UPDATE "Subscription" s
SET "customDomain" = NULL
FROM ranked r
WHERE s."id" = r."id" AND r.rn > 1;

-- Step 2 — enforce uniqueness. IF NOT EXISTS keeps re-application idempotent
-- when applying to an already-patched schema (e.g. hr_test).
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_customDomain_key" ON "Subscription"("customDomain");
