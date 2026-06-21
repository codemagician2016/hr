-- GDPR Article 17 — soft-delete with 30-day grace + immutable AccountAuditLog
-- See backend/src/core/lib/accountDeletion.js for the deletion + purge cron.

-- Soft-delete fields on User
ALTER TABLE "User"
  ADD COLUMN "pendingDeletionAt" TIMESTAMP(3),
  ADD COLUMN "anonymisedAt"      TIMESTAMP(3);

-- Soft-delete fields on Business
ALTER TABLE "Business"
  ADD COLUMN "pendingDeletionAt" TIMESTAMP(3),
  ADD COLUMN "anonymisedAt"      TIMESTAMP(3);

-- Soft-delete fields on Customer
ALTER TABLE "Customer"
  ADD COLUMN "pendingDeletionAt" TIMESTAMP(3),
  ADD COLUMN "anonymisedAt"      TIMESTAMP(3);

-- AccountAuditLog — append-only, retained forever
CREATE TABLE "AccountAuditLog" (
  "id"                TEXT NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "eventType"         TEXT NOT NULL,
  "targetType"        TEXT NOT NULL,
  "targetId"          TEXT NOT NULL,
  "targetSlug"        TEXT,
  "originalEmail"     TEXT,
  "originalEmailHash" TEXT,
  "originalName"      TEXT,
  "originalPhone"     TEXT,
  "ownerCountry"      TEXT,
  "ipAddress"         TEXT,
  "userAgent"         TEXT,
  "reason"            TEXT,
  "payload"           JSONB,
  CONSTRAINT "AccountAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AccountAuditLog_eventType_createdAt_idx"   ON "AccountAuditLog"("eventType", "createdAt");
CREATE INDEX "AccountAuditLog_targetType_targetId_idx"   ON "AccountAuditLog"("targetType", "targetId");
CREATE INDEX "AccountAuditLog_originalEmailHash_idx"     ON "AccountAuditLog"("originalEmailHash");

-- Helpful indexes for the 30-day-purge cron sweeps
CREATE INDEX "User_pendingDeletionAt_idx"     ON "User"("pendingDeletionAt") WHERE "pendingDeletionAt" IS NOT NULL;
CREATE INDEX "Business_pendingDeletionAt_idx" ON "Business"("pendingDeletionAt") WHERE "pendingDeletionAt" IS NOT NULL;
CREATE INDEX "Customer_pendingDeletionAt_idx" ON "Customer"("pendingDeletionAt") WHERE "pendingDeletionAt" IS NOT NULL;
