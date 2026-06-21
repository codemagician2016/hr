-- Bug severity (Critical / Medium / Low). Defaults to LOW so testers don't have to
-- pick — they only raise it for the rare high-priority issue. Additive.
ALTER TABLE "QaIssue" ADD COLUMN IF NOT EXISTS "severity" TEXT NOT NULL DEFAULT 'LOW';
CREATE INDEX IF NOT EXISTS "QaIssue_projectId_severity_idx" ON "QaIssue"("projectId", "severity");
