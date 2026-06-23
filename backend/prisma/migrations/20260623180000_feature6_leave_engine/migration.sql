-- Feature 6 (Leave Management) §3.2 — optional additive columns for the leave engine.
-- Additive only (no destructive change). Hand-authored to be idempotent so it applies
-- cleanly to the isolated hr_test schema (bootstrapped via `prisma db push`) as well as
-- a clean migrate-deploy: the CREATE TYPE is DO-block guarded and every ADD COLUMN uses
-- IF NOT EXISTS. No column is renamed or dropped; no table is created. The 7 leave models
-- + Holiday were already shipped; this only adds the two nullable, default-safe columns
-- the apply-time netting (sandwich) and the FnF encashment cap reference.

-- ── CreateEnum (guarded — CREATE TYPE has no IF NOT EXISTS) ──
-- SandwichPolicy: how interior holidays/weekoffs inside a leave block are treated.
-- INCLUSIVE = debited (IN EL); EXCLUSIVE = paid as a holiday, never debited (NZ Holidays
-- Act). NULL on a LeaveType ⇒ the engine derives it from countryCode (NZ ⇒ EXCLUSIVE).
DO $$ BEGIN
  CREATE TYPE "SandwichPolicy" AS ENUM ('INCLUSIVE', 'EXCLUSIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── AlterTable: LeaveType.sandwichPolicy (nullable; default-safe) ──
ALTER TABLE "LeaveType" ADD COLUMN IF NOT EXISTS "sandwichPolicy" "SandwichPolicy";

-- ── AlterTable: LeavePolicy.maxEncashCap (nullable; NULL = unbounded) ──
ALTER TABLE "LeavePolicy" ADD COLUMN IF NOT EXISTS "maxEncashCap" DECIMAL(8,4);
