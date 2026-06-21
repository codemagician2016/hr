-- Sprint 2.7 — Multi-store (ECOMMERCE Business tier)

CREATE TABLE "StoreBrand" (
  "id"            TEXT NOT NULL,
  "businessId"    TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "slug"          TEXT NOT NULL,
  "description"   TEXT,
  "logoUrl"       TEXT,
  "customDomain"  TEXT,
  "themeColors"   TEXT,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoreBrand_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StoreBrand_businessId_slug_key" ON "StoreBrand"("businessId", "slug");
CREATE INDEX "StoreBrand_businessId_isActive_idx" ON "StoreBrand"("businessId", "isActive");
ALTER TABLE "StoreBrand" ADD CONSTRAINT "StoreBrand_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
