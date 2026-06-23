-- Feature 10 (Configurable Approval-Workflow Engine) — Slice 10a. Additive only.
-- Hand-authored to be idempotent so it applies cleanly to the isolated hr_test schema
-- (bootstrapped via `prisma db push`) as well as a clean migrate-deploy on the box
-- (psql stdin). Every CREATE / ADD uses IF NOT EXISTS (or a DO-block guard for the
-- enum value + FK + array column, which lack IF NOT EXISTS for the object itself).
--
-- The 4 core models (WorkflowDefinition / WorkflowStep / ApprovalRequest /
-- ApprovalAction) + 5 enums already exist. This migration:
--   * extends WorkflowDefinition with the §4.1 selector + draft/publish columns + index
--   * adds the TRAVEL value to the WorkflowModule enum (§4.5)
--   * adds the ApprovalDelegation model (§4.3) + its 3 indexes + 3 FKs
-- NO drops, NO renames, NO data backfill. Zero-config tenants keep BUILT_IN_DEFAULT
-- behaviour (they simply have zero WorkflowDefinition rows).

-- ── WorkflowModule.TRAVEL (guarded; ADD VALUE has no IF NOT EXISTS pre-PG12 syntax) ─
-- ADD VALUE IF NOT EXISTS is supported on PG12+; the DO-block makes it safe on a
-- re-apply regardless. It must NOT run inside an explicit transaction block, which
-- the psql-stdin / db-push path satisfies (each statement auto-commits).
DO $$ BEGIN
  ALTER TYPE "WorkflowModule" ADD VALUE IF NOT EXISTS 'TRAVEL';
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── WorkflowDefinition — additive selector + draft/publish refinement columns (§4.1) ─
ALTER TABLE "WorkflowDefinition" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "WorkflowDefinition" ADD COLUMN IF NOT EXISTS "scopeJson" JSONB;
ALTER TABLE "WorkflowDefinition" ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "WorkflowDefinition" ADD COLUMN IF NOT EXISTS "isPublished" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WorkflowDefinition" ADD COLUMN IF NOT EXISTS "createdBy" TEXT;
ALTER TABLE "WorkflowDefinition" ADD COLUMN IF NOT EXISTS "updatedBy" TEXT;
CREATE INDEX IF NOT EXISTS "WorkflowDefinition_businessId_module_isActive_isPublished_idx"
  ON "WorkflowDefinition"("businessId","module","isActive","isPublished");

-- ── ApprovalDelegation — out-of-office "approve on my behalf" (§4.3) ─────────────────
CREATE TABLE IF NOT EXISTS "ApprovalDelegation" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "fromUserId" TEXT NOT NULL,
  "toUserId" TEXT NOT NULL,
  "modules" "WorkflowModule"[] DEFAULT ARRAY[]::"WorkflowModule"[],
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApprovalDelegation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ApprovalDelegation_businessId_fromUserId_isActive_idx" ON "ApprovalDelegation"("businessId","fromUserId","isActive");
CREATE INDEX IF NOT EXISTS "ApprovalDelegation_businessId_toUserId_isActive_idx" ON "ApprovalDelegation"("businessId","toUserId","isActive");
CREATE INDEX IF NOT EXISTS "ApprovalDelegation_businessId_startsAt_endsAt_idx" ON "ApprovalDelegation"("businessId","startsAt","endsAt");

-- ── AddForeignKey (guarded — ADD CONSTRAINT has no IF NOT EXISTS) ───────────────────
DO $$ BEGIN
  ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── WorkflowStep parallel-level support (§4.2) ──────────────────────────────────
-- Steps sharing a stepOrder form ONE parallel level (minApprovals governs it). The
-- original strict unique(businessId, workflowDefinitionId, stepOrder) forbids that,
-- so we relax it to a PARTIAL unique that only enforces uniqueness for NON-parallel
-- steps. This is strictly MORE permissive (no data loss): every row that was unique
-- before still is, but two parallel steps may now share an order. Prisma cannot
-- express a WHERE-filtered unique, hence raw SQL.
DROP INDEX IF EXISTS "WorkflowStep_businessId_workflowDefinitionId_stepOrder_key";
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_workflowstep_seq"
  ON "WorkflowStep"("businessId","workflowDefinitionId","stepOrder")
  WHERE NOT "isParallel";
-- A plain (non-unique) lookup index on the same tuple for the engine's ordered reads.
CREATE INDEX IF NOT EXISTS "WorkflowStep_businessId_workflowDefinitionId_stepOrder_idx"
  ON "WorkflowStep"("businessId","workflowDefinitionId","stepOrder");
