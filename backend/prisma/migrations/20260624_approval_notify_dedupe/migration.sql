-- Approval/SLA notification fan-out — atomic send-dedupe (review MED finding).
--
-- notify.dispatchOne previously deduped with a CHECK-then-ACT against
-- MessageDelivery.triggeredBy (alreadySent → notifyHrEvent). Two overlapping SLA sweeps
-- (or a sweep + a retry) could BOTH observe "not sent" and BOTH fire the same approval
-- notice — a double-send. There was no DB-level uniqueness backing the dedupe token.
--
-- This migration adds a dedicated claim table whose UNIQUE(businessId, token) turns the
-- dedupe into a single atomic INSERT: the first send claims the token and proceeds; a
-- concurrent second send hits the unique violation (P2002), gets claimed:false and skips.
-- The claim is RELEASED (deleted) when a dispatch fails, so a genuine retry of a transient
-- provider outage can re-send.
--
-- ADDITIVE + SAFE on a live tenant:
--   * a brand-new table — no change to any existing column/row, no backfill;
--   * IF NOT EXISTS keeps it idempotent against a previously `db push`-ed schema;
--   * ON DELETE CASCADE on businessId matches every other tenant-scoped table.

CREATE TABLE IF NOT EXISTS "HrNotifyDedupe" (
  "id"         TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "token"      TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HrNotifyDedupe_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "HrNotifyDedupe_businessId_token_key"
  ON "HrNotifyDedupe" ("businessId", "token");

CREATE INDEX IF NOT EXISTS "HrNotifyDedupe_businessId_createdAt_idx"
  ON "HrNotifyDedupe" ("businessId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'HrNotifyDedupe_businessId_fkey'
  ) THEN
    ALTER TABLE "HrNotifyDedupe"
      ADD CONSTRAINT "HrNotifyDedupe_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
