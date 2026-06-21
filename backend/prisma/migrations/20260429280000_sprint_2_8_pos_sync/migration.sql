-- Sprint 2.8 — POS sync (ECOMMERCE Business tier)

CREATE TABLE "PosIntegration" (
  "id"             TEXT NOT NULL,
  "businessId"     TEXT NOT NULL,
  "provider"       TEXT NOT NULL,
  "accessToken"    TEXT NOT NULL,
  "refreshToken"   TEXT,
  "tokenExpiresAt" TIMESTAMP(3),
  "merchantId"     TEXT,
  "syncEnabled"    BOOLEAN NOT NULL DEFAULT false,
  "lastSyncedAt"   TIMESTAMP(3),
  "lastSyncStatus" TEXT,
  "lastSyncError"  TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PosIntegration_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PosIntegration_businessId_provider_key" ON "PosIntegration"("businessId", "provider");
CREATE INDEX "PosIntegration_businessId_idx" ON "PosIntegration"("businessId");
ALTER TABLE "PosIntegration" ADD CONSTRAINT "PosIntegration_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
