-- Feature 12 (Recruitment / ATS) enhancement — additive, idempotent.
-- Records WHY a requisition was closed so the per-job summary / audit trail can
-- show the reason alongside closedAt. Nullable TEXT; safe for existing rows.
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "closeReason" TEXT;
