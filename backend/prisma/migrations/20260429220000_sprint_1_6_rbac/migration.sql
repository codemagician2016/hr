-- Sprint 1.6 — RBAC custom roles (Business tier)

CREATE TABLE "BusinessRole" (
  "id"          TEXT NOT NULL,
  "businessId"  TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "permissions" JSONB NOT NULL DEFAULT '{}',
  "isSystem"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessRole_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BusinessRole_businessId_name_key"
  ON "BusinessRole"("businessId", "name");
CREATE INDEX "BusinessRole_businessId_idx"
  ON "BusinessRole"("businessId");
ALTER TABLE "BusinessRole"
  ADD CONSTRAINT "BusinessRole_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
