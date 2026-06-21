-- CreateEnum
CREATE TYPE "AdminCouponBenefitType" AS ENUM ('FREE_PERIOD', 'LIFETIME_FREE', 'PERCENT_OFF', 'FIXED_OFF');

-- CreateEnum
CREATE TYPE "AdminCouponBenefitUnit" AS ENUM ('DAYS', 'MONTHS', 'CYCLES');

-- CreateTable
CREATE TABLE "AdminCoupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "benefitType" "AdminCouponBenefitType" NOT NULL,
    "benefitValue" DOUBLE PRECISION,
    "benefitUnit" "AdminCouponBenefitUnit",
    "benefitCurrency" TEXT,
    "allowedCountries" TEXT[],
    "allowedEmails" TEXT[],
    "allowedBusinessIds" TEXT[],
    "applicableTiers" TEXT[],
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "maxTotalUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "maxPerUser" INTEGER,
    "firstSubscriptionOnly" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminCoupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminCouponRedemption" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "benefitSnapshot" JSONB NOT NULL,
    "appliedFreeDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminCouponRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminCoupon_code_key" ON "AdminCoupon"("code");

-- CreateIndex
CREATE INDEX "AdminCouponRedemption_businessId_idx" ON "AdminCouponRedemption"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminCouponRedemption_couponId_businessId_key" ON "AdminCouponRedemption"("couponId", "businessId");

-- AddForeignKey
ALTER TABLE "AdminCouponRedemption" ADD CONSTRAINT "AdminCouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "AdminCoupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
