-- Feature 16 — Attendance-driven payroll proration + LWP (Leave Without Pay), India.
-- ADDITIVE ONLY. Hand-authored to be idempotent (every ADD uses IF NOT EXISTS,
-- every enum value is added conditionally) so it applies cleanly to the isolated
-- hr_test schema and on a clean migrate-deploy. NO existing column is touched; NO
-- drops. Every new column is nullable or defaulted so existing rows stay valid.

-- ── AccrualMethod.NONE — LWP / no-accrual leave types never grant a balance ─────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'AccrualMethod' AND e.enumlabel = 'NONE'
  ) THEN
    ALTER TYPE "AccrualMethod" ADD VALUE 'NONE';
  END IF;
END$$;

-- ── Entity.prorationBasis — the salary-proration denominator policy (nullable) ──
ALTER TABLE "Entity" ADD COLUMN IF NOT EXISTS "prorationBasis" "ProrationMethod";

-- ── AttendancePayInput — LOP provenance split + frozen standard-days denominator
ALTER TABLE "AttendancePayInput" ADD COLUMN IF NOT EXISTS "lwpDays"      DECIMAL(8,4) NOT NULL DEFAULT 0;
ALTER TABLE "AttendancePayInput" ADD COLUMN IF NOT EXISTS "absentDays"   DECIMAL(8,4) NOT NULL DEFAULT 0;
ALTER TABLE "AttendancePayInput" ADD COLUMN IF NOT EXISTS "standardDays" DECIMAL(8,4) NOT NULL DEFAULT 0;

-- ── PayRunLine — approved LWP days (subset of lopDays) for payslip provenance ───
ALTER TABLE "PayRunLine" ADD COLUMN IF NOT EXISTS "lwpDays" DECIMAL(8,4) NOT NULL DEFAULT 0;

-- ── LeavePolicy — as-authored India statutory floor stamp (live gate re-resolves)
ALTER TABLE "LeavePolicy" ADD COLUMN IF NOT EXISTS "statutoryFloorPerYear" DECIMAL(8,4);
