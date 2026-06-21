-- StorePolicy: per-tenant storefront legal policies (footer + signup acceptance)
CREATE TABLE "StorePolicy" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "showInFooter" BOOLEAN NOT NULL DEFAULT true,
    "showAtSignup" BOOLEAN NOT NULL DEFAULT false,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StorePolicy_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StorePolicy_businessId_slug_key" ON "StorePolicy"("businessId", "slug");
CREATE INDEX "StorePolicy_businessId_idx" ON "StorePolicy"("businessId");
ALTER TABLE "StorePolicy" ADD CONSTRAINT "StorePolicy_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
