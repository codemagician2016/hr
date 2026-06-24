-- Feature 23 — Statutory Compliance Calendar + reminder cron (India-first).
-- ADDITIVE only: five new RemittanceKind values (effective-dated successors +
-- non-payrun obligations), eleven nullable/defaulted columns on the EXISTING
-- StatutoryRemittance instance table (so the fileRun() writer's rows stay valid),
-- one new ComplianceCadence enum, and one new ComplianceObligation definition
-- table. No NOT NULL on an existing column, no backfill — safe on a live tenant
-- (mirrors the additive migrations of feature10/17/19/21_22). IF NOT EXISTS /
-- DO-block guards keep it idempotent for db-push parity + re-runs.

-- ── RemittanceKind additions (ADD VALUE cannot run inside a tx block; the
--    IF NOT EXISTS makes each idempotent). 24Q→138 and 16→130 are effective-dated
--    DATA on ComplianceObligation, never a code branch. ──
ALTER TYPE "RemittanceKind" ADD VALUE IF NOT EXISTS 'IN_FORM138';
ALTER TYPE "RemittanceKind" ADD VALUE IF NOT EXISTS 'IN_FORM130';
ALTER TYPE "RemittanceKind" ADD VALUE IF NOT EXISTS 'IN_ESI_RETURN';
ALTER TYPE "RemittanceKind" ADD VALUE IF NOT EXISTS 'IN_PF_ANNUAL';
ALTER TYPE "RemittanceKind" ADD VALUE IF NOT EXISTS 'IN_GRATUITY';

-- ── ComplianceCadence enum ──
DO $$ BEGIN
  CREATE TYPE "ComplianceCadence" AS ENUM ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL', 'EVENT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── ComplianceObligation — the per-tenant rule schedule (definition) ──
CREATE TABLE IF NOT EXISTS "ComplianceObligation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" "RemittanceKind" NOT NULL,
    "stateCode" TEXT,
    "cadence" "ComplianceCadence" NOT NULL,
    "dueDom" INTEGER,
    "dueMonths" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "offsetMonths" INTEGER NOT NULL DEFAULT 1,
    "specialRules" JSONB,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "supersededBy" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "autoGenerate" BOOLEAN NOT NULL DEFAULT true,
    "reminderDays" INTEGER[] DEFAULT ARRAY[7, 3, 1, 0]::INTEGER[],
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ComplianceObligation_pkey" PRIMARY KEY ("id")
);

-- Natural-key uniqueness for the per-(entity, kind, state, effectiveFrom) schedule.
-- COALESCE the nullable stateCode so PT/LWF per-state rows are unique and an
-- entity-wide NULL collapses to a single row (Postgres treats NULL as distinct in
-- a plain unique index, which would let dup NULL rows in — the expression index
-- closes that).
CREATE UNIQUE INDEX IF NOT EXISTS "ComplianceObligation_natural_key"
  ON "ComplianceObligation" ("businessId", "entityId", "kind", (COALESCE("stateCode", '')), "effectiveFrom");
CREATE INDEX IF NOT EXISTS "ComplianceObligation_businessId_entityId_isActive_idx"
  ON "ComplianceObligation" ("businessId", "entityId", "isActive");

-- ── StatutoryRemittance additive columns (all nullable / defaulted) ──
ALTER TABLE "StatutoryRemittance" ADD COLUMN IF NOT EXISTS "obligationId" TEXT;
ALTER TABLE "StatutoryRemittance" ADD COLUMN IF NOT EXISTS "stateCode" TEXT;
ALTER TABLE "StatutoryRemittance" ADD COLUMN IF NOT EXISTS "proofUrl" TEXT;
ALTER TABLE "StatutoryRemittance" ADD COLUMN IF NOT EXISTS "proofUploadedAt" TIMESTAMP(3);
ALTER TABLE "StatutoryRemittance" ADD COLUMN IF NOT EXISTS "filedByUserId" TEXT;
ALTER TABLE "StatutoryRemittance" ADD COLUMN IF NOT EXISTS "lastReminderAt" TIMESTAMP(3);
ALTER TABLE "StatutoryRemittance" ADD COLUMN IF NOT EXISTS "remindersSent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "StatutoryRemittance" ADD COLUMN IF NOT EXISTS "reminderStage" TEXT;
ALTER TABLE "StatutoryRemittance" ADD COLUMN IF NOT EXISTS "waivedReason" TEXT;

-- FK obligationId → ComplianceObligation (SET NULL on delete so a removed
-- definition never orphans the immutable instance/proof). Guarded so a re-run
-- (or db-push parity) doesn't error on the existing constraint.
DO $$ BEGIN
  ALTER TABLE "StatutoryRemittance"
    ADD CONSTRAINT "StatutoryRemittance_obligationId_fkey"
    FOREIGN KEY ("obligationId") REFERENCES "ComplianceObligation"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "StatutoryRemittance_businessId_obligationId_idx"
  ON "StatutoryRemittance" ("businessId", "obligationId");

-- ComplianceObligation FKs (businessId → Business, entityId → Entity). Cascade on
-- delete: a tenant/entity teardown removes its obligation definitions (the shared
-- instance rows are SET NULL via the FK above, never deleted by this).
DO $$ BEGIN
  ALTER TABLE "ComplianceObligation"
    ADD CONSTRAINT "ComplianceObligation_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ComplianceObligation"
    ADD CONSTRAINT "ComplianceObligation_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "Entity"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
