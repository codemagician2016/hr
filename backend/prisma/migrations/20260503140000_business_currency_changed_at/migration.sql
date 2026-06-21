-- Track when defaultCurrency was last manually changed so the 90-day
-- rate-limit guard in business.controller.js can enforce it.
ALTER TABLE "Business" ADD COLUMN "currencyChangedAt" TIMESTAMP(3);
