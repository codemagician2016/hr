-- Admin-created agent API keys (for Claude/Codex to work issues via the API).
-- Only the sha256 hash is stored; the raw token is shown once at creation.
CREATE TABLE IF NOT EXISTS "QaAgentKey" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "tokenHash"   TEXT NOT NULL,
  "tokenPrefix" TEXT NOT NULL,
  "createdById" TEXT,
  "lastUsedAt"  TIMESTAMP(3),
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QaAgentKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "QaAgentKey_tokenHash_key" ON "QaAgentKey"("tokenHash");
CREATE INDEX IF NOT EXISTS "QaAgentKey_isActive_idx" ON "QaAgentKey"("isActive");
