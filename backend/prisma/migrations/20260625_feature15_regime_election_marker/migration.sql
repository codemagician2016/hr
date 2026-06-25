-- Feature 15/25 — Income-tax REGIME ELECTION MARKER (the root-cause fix).
-- PURELY ADDITIVE: one new NULLABLE column on StatutoryProfile (regimeElectedAt — the
-- TRUE "this employee deliberately elected" signal). NO NOT NULL on an existing column,
-- NO destructive change — safe on a live tenant (mirrors the additive style of
-- feature15_tax_regime_policy). IF NOT EXISTS guards keep it idempotent for db-push
-- parity + re-runs.
--
-- WHY: StatutoryProfile.taxRegime is `INTaxRegime? @default(NEW)` AND provisioning writes
-- it explicitly, so a stored value can NOT distinguish "elected NEW" from "never elected".
-- The resolver (getEffectiveRegime) therefore treated EVERY un-elected employee as ELECTED
-- and skipped the employer default. The marker restores the distinction: NULL = never
-- elected → fall back to TaxRegimePolicy.defaultRegime, then statutory NEW.

-- ── StatutoryProfile.regimeElectedAt — per-employee election marker (nullable) ─
ALTER TABLE "StatutoryProfile" ADD COLUMN IF NOT EXISTS "regimeElectedAt" TIMESTAMP(3);

-- ── GUARDED BACKFILL — preserve GENUINELY-elected employees ───────────────────
-- An employee who actually elected before this fix has an append-only audit row
-- (StatutoryElectionHistory, field='taxRegime'). Those — and ONLY those — are real
-- elections, so stamp their marker from the latest such row's createdAt. Employees
-- whose taxRegime is merely the @default(NEW)/provisioning write (no history) are left
-- NULL and correctly fall back to the employer default. Idempotent: only fills NULLs.
UPDATE "StatutoryProfile" sp
SET "regimeElectedAt" = h."latestAt"
FROM (
  SELECT "statutoryProfileId", MAX("createdAt") AS "latestAt"
  FROM "StatutoryElectionHistory"
  WHERE "field" = 'taxRegime'
  GROUP BY "statutoryProfileId"
) h
WHERE h."statutoryProfileId" = sp."id"
  AND sp."regimeElectedAt" IS NULL;
