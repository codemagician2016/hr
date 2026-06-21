-- AapkaConnect: one generic engine connects a tenant to any external service app.
CREATE TABLE "ServiceConnection" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEnc" TEXT,
    "webhookSecret" TEXT,
    "manifest" JSONB,
    "workspaceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ServiceConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ServiceConnection_businessId_category_key" ON "ServiceConnection"("businessId", "category");
CREATE INDEX "ServiceConnection_businessId_idx" ON "ServiceConnection"("businessId");
