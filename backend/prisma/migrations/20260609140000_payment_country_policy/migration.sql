-- Per-country buyer-payment policy: whether INTEGRATED (Stripe Connect /
-- Razorpay Route) buyer payments are offered to sellers in that country, or
-- BYO-only. No row = the safe default (BYO-only). Additive + non-breaking.

CREATE TABLE "PaymentCountryPolicy" (
  "countryCode" TEXT NOT NULL,
  "integratedEnabled" BOOLEAN NOT NULL DEFAULT false,
  "updatedBy" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentCountryPolicy_pkey" PRIMARY KEY ("countryCode")
);
