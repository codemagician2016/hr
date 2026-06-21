-- CreateEnum
CREATE TYPE "TierFeatureType" AS ENUM ('BOOLEAN', 'NUMERIC', 'UNLIMITED');

-- CreateEnum
CREATE TYPE "DiscountCycle" AS ENUM ('MONTHLY', 'ANNUAL', 'BOTH');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATED', 'UPDATED', 'DELETED', 'SYNCED');

-- CreateEnum
CREATE TYPE "PaddleSyncStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'PARTIAL');

-- CreateTable
CREATE TABLE "PricingTier" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "badge" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isCustomPriced" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "trialDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingZone" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "multiplier" DECIMAL(5,4) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CountryZoneAssignment" (
    "id" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "countryName" TEXT NOT NULL,
    "region" TEXT,
    "currencyCode" TEXT NOT NULL,
    "currencySymbol" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "isOverride" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CountryZoneAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TierPrice" (
    "id" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "countryCode" TEXT,
    "currencyCode" TEXT NOT NULL,
    "amountMonthlyMinor" INTEGER NOT NULL,
    "amountAnnualMinor" INTEGER NOT NULL,
    "overageStaffPriceMinor" INTEGER NOT NULL DEFAULT 0,
    "isOverride" BOOLEAN NOT NULL DEFAULT false,
    "paddlePriceIdMonthly" TEXT,
    "paddlePriceIdAnnual" TEXT,
    "lastSyncedToPaddleAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TierPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TierFeature" (
    "id" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "featureType" "TierFeatureType" NOT NULL,
    "featureValue" TEXT NOT NULL,
    "displayLabel" TEXT NOT NULL,
    "description" TEXT,
    "isHighlighted" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TierFeature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Discount" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "type" "DiscountType" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "appliesToTierIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "appliesToZoneIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "appliesToCountryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "appliesToBillingCycle" "DiscountCycle" NOT NULL DEFAULT 'BOTH',
    "maxRedemptions" INTEGER,
    "currentRedemptions" INTEGER NOT NULL DEFAULT 0,
    "maxPerCustomer" INTEGER NOT NULL DEFAULT 1,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3),
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "paddleDiscountId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Discount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingAuditLog" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "changedBy" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaddleSyncJob" (
    "id" TEXT NOT NULL,
    "status" "PaddleSyncStatus" NOT NULL DEFAULT 'PENDING',
    "initiatedBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "itemsFailed" INTEGER NOT NULL DEFAULT 0,
    "errorLog" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaddleSyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PricingTier_slug_key" ON "PricingTier"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "PricingZone_slug_key" ON "PricingZone"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "CountryZoneAssignment_countryCode_key" ON "CountryZoneAssignment"("countryCode");

-- CreateIndex
CREATE INDEX "CountryZoneAssignment_zoneId_idx" ON "CountryZoneAssignment"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "TierPrice_tierId_countryCode_key" ON "TierPrice"("tierId", "countryCode");

-- CreateIndex
CREATE INDEX "TierPrice_countryCode_idx" ON "TierPrice"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "TierFeature_tierId_featureKey_key" ON "TierFeature"("tierId", "featureKey");

-- CreateIndex
CREATE UNIQUE INDEX "Discount_code_key" ON "Discount"("code");

-- CreateIndex
CREATE INDEX "Discount_isActive_validFrom_validUntil_idx" ON "Discount"("isActive", "validFrom", "validUntil");

-- CreateIndex
CREATE INDEX "PricingAuditLog_entityType_entityId_idx" ON "PricingAuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "PricingAuditLog_changedBy_createdAt_idx" ON "PricingAuditLog"("changedBy", "createdAt");

-- CreateIndex
CREATE INDEX "PaddleSyncJob_status_startedAt_idx" ON "PaddleSyncJob"("status", "startedAt");

-- AddForeignKey
ALTER TABLE "CountryZoneAssignment" ADD CONSTRAINT "CountryZoneAssignment_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "PricingZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TierPrice" ADD CONSTRAINT "TierPrice_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "PricingTier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TierFeature" ADD CONSTRAINT "TierFeature_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "PricingTier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
