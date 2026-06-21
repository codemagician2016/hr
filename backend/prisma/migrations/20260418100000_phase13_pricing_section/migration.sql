-- Make Service.price optional so business owners can skip it
ALTER TABLE "Service" ALTER COLUMN "price" DROP NOT NULL;

-- Pricing section
ALTER TABLE "BusinessContent" ADD COLUMN "pricingTiers" TEXT,
ADD COLUMN "showPricing" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "pricingEyebrow" TEXT,
ADD COLUMN "pricingTitle" TEXT,
ADD COLUMN "pricingIntro" TEXT;
