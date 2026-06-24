-- Cycle 2b — StatutoryRemittance natural-key uniqueness (compliance calendar fix).
--
-- The per-period INSTANCE row is written by BOTH service.js fileRun() and the
-- compliance generator (calendarRunner.upsertStub). upsertStub's P2002 race guard
-- was DEAD CODE because no DB unique existed on the natural key — two concurrent
-- generates (or a generate racing fileRun) could each pass the findFirst() check
-- and INSERT, leaving a duplicate obligation + perpetual false-overdue reminders.
--
-- This migration is ADDITIVE: it (1) DEDUPES any pre-existing duplicates on the
-- natural key, keeping the most-progressed/authoritative row, then (2) installs a
-- UNIQUE expression index COALESCE(stateCode,'') so the upsert/P2002 guard works.
-- The COALESCE mirrors ComplianceObligation_natural_key — Postgres treats NULL as
-- DISTINCT in a plain unique index, which would otherwise let duplicate entity-wide
-- (NULL stateCode) rows slip through. Idempotent (IF NOT EXISTS) for db-push parity.

-- ── 1) Dedupe existing rows on (businessId, entityId, kind, taxPeriod, stateCode∅).
--    Rank: terminal/most-progressed status first, then larger amount (payroll wrote
--    a real figure; the generator stub is amount 0), then most recent. Keep rank 1;
--    delete the losers. StatutoryRemittance is a leaf (no child FKs reference it),
--    so a plain DELETE is safe.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "businessId", "entityId", "kind", "taxPeriod", COALESCE("stateCode", '')
      ORDER BY
        CASE "status"
          WHEN 'PAID'    THEN 0
          WHEN 'FILED'   THEN 1
          WHEN 'WAIVED'  THEN 2
          WHEN 'OVERDUE' THEN 3
          WHEN 'DUE'     THEN 4
          WHEN 'PENDING' THEN 5
          ELSE 6
        END ASC,
        CASE WHEN "obligationId" IS NOT NULL THEN 0 ELSE 1 END ASC, -- keep a back-linked row
        "amount" DESC,
        "updatedAt" DESC,
        "createdAt" DESC,
        "id" ASC
    ) AS rn
  FROM "StatutoryRemittance"
)
DELETE FROM "StatutoryRemittance" s
USING ranked r
WHERE s."id" = r."id" AND r.rn > 1;

-- ── 2) UNIQUE natural-key index (NULL-safe via COALESCE). ──
CREATE UNIQUE INDEX IF NOT EXISTS "StatutoryRemittance_natural_key"
  ON "StatutoryRemittance" ("businessId", "entityId", "kind", "taxPeriod", (COALESCE("stateCode", '')));
