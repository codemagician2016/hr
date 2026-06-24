-- Feature 24 (Form 16 / 24Q) — regenerate must SUPERSEDE, never mutate a frozen
-- ISSUED certificate. ADDITIVE + index-swap only; no data is rewritten.
--
--   1. Form16CertStatus gains 'SUPERSEDED' (immutable history: a row replaced by a
--      re-generated certificate, linked via supersededByCertId).
--   2. Form16Certificate gains supersedesCertId / supersededByCertId (the chain,
--      mirroring IssuedLetter.supersedes/supersededBy — plain columns, no FK).
--   3. The "one cert per employee per batch" rule becomes a PARTIAL unique index over
--      ACTIVE rows only (status in PENDING/ISSUED/PENDING_SIGNATURE/VOIDED), so a
--      SUPERSEDED cert and its replacement legitimately coexist for the same
--      (business, batch, employee). The old full unique index is dropped.

-- 1. New enum value (idempotent). Note: we DELIBERATELY do not reference the new
--    'SUPERSEDED' literal anywhere else in this migration (the partial index below
--    enumerates the pre-existing active states instead), so this is safe even though
--    Postgres restricts using a freshly-added enum value within the same transaction.
ALTER TYPE "Form16CertStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';

-- 2. Supersede-chain columns (nullable, additive).
ALTER TABLE "Form16Certificate" ADD COLUMN IF NOT EXISTS "supersedesCertId" TEXT;
ALTER TABLE "Form16Certificate" ADD COLUMN IF NOT EXISTS "supersededByCertId" TEXT;

-- 3. Swap the full unique for a PARTIAL unique over active rows only.
DROP INDEX IF EXISTS "Form16Certificate_businessId_batchId_employeeId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Form16Certificate_active_emp_batch_key"
  ON "Form16Certificate"("businessId", "batchId", "employeeId")
  WHERE "status" IN ('PENDING', 'ISSUED', 'PENDING_SIGNATURE', 'VOIDED');

-- Keep a plain (non-unique) lookup index on the same tuple (replaces the dropped
-- unique for query planning; the supersede history rows are still indexed).
CREATE INDEX IF NOT EXISTS "Form16Certificate_businessId_batchId_employeeId_idx"
  ON "Form16Certificate"("businessId", "batchId", "employeeId");
