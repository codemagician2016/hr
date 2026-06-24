-- Feature 4 — Employee portal-invitation / credential flow.
-- ADDITIVE only: one new enum (EmployeeInviteStatus) + one new table
-- (EmployeeInvite) that holds the welcome/set-password tokens minted for a new
-- hire's ESS (Customer) login. No changes to existing data, no NOT NULL on an
-- existing column, no backfill — safe on a live tenant (mirrors the additive
-- migrations of feature10/13/17/19/21). IF NOT EXISTS guards keep it idempotent.
--
-- SECURITY: only the SHA-256 HASH of the raw token is persisted (tokenHash is
-- UNIQUE so a presented token resolves to exactly one tenant-scoped row). The raw
-- token lives only in the welcome link; a DB leak never yields a usable token.

-- ── EmployeeInviteStatus enum ──
DO $$ BEGIN
  CREATE TYPE "EmployeeInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── EmployeeInvite table ──
CREATE TABLE IF NOT EXISTS "EmployeeInvite" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "status" "EmployeeInviteStatus" NOT NULL DEFAULT 'PENDING',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeInvite_pkey" PRIMARY KEY ("id")
);

-- A presented token must resolve to exactly one row (no cross-tenant ambiguity).
CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeInvite_tokenHash_key" ON "EmployeeInvite"("tokenHash");
CREATE INDEX IF NOT EXISTS "EmployeeInvite_businessId_employeeId_idx" ON "EmployeeInvite"("businessId", "employeeId");
CREATE INDEX IF NOT EXISTS "EmployeeInvite_businessId_status_idx" ON "EmployeeInvite"("businessId", "status");

-- FKs (guarded so re-running is a no-op). ON DELETE CASCADE mirrors the schema —
-- removing a tenant or an employee removes their pending invites.
DO $$ BEGIN
  ALTER TABLE "EmployeeInvite"
    ADD CONSTRAINT "EmployeeInvite_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "EmployeeInvite"
    ADD CONSTRAINT "EmployeeInvite_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
