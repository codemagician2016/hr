-- BusinessIntegration: per-tenant connection to a video provider
-- (google_meet | zoom | ms_teams). Tokens are stored encrypted with
-- AES-256-GCM keyed off JWT_SECRET — see backend/src/lib/crypto.js.

CREATE TABLE "BusinessIntegration" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "scopes" TEXT,
    "externalAccountId" TEXT,
    "externalAccountEmail" TEXT,
    "refreshTokenEncrypted" TEXT,
    "accessTokenEncrypted" TEXT,
    "accessTokenExpiry" TIMESTAMP(3),
    "connectedByUserId" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessIntegration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BusinessIntegration_businessId_provider_key" ON "BusinessIntegration"("businessId", "provider");
CREATE INDEX "BusinessIntegration_provider_idx" ON "BusinessIntegration"("provider");
CREATE INDEX "BusinessIntegration_status_idx" ON "BusinessIntegration"("status");

ALTER TABLE "BusinessIntegration" ADD CONSTRAINT "BusinessIntegration_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
