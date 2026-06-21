CREATE TABLE IF NOT EXISTS "BillingPurchase" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "productKind" TEXT NOT NULL,
  "checkoutKind" TEXT,
  "status" TEXT NOT NULL DEFAULT 'CHECKOUT_CREATED',
  "expectedPriceId" TEXT,
  "expectedCurrencyCode" TEXT,
  "expectedAmountMinor" INTEGER,
  "actualCurrencyCode" TEXT,
  "actualSubtotalMinor" INTEGER,
  "actualTaxMinor" INTEGER,
  "actualTotalMinor" INTEGER,
  "paddleCustomerId" TEXT,
  "paddleTransactionId" TEXT,
  "paddleSubscriptionId" TEXT,
  "invoiceId" TEXT,
  "invoiceNumber" TEXT,
  "invoiceUrl" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BillingPurchase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PaymentAttempt" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "purchaseId" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'paddle',
  "status" TEXT NOT NULL,
  "amountMinor" INTEGER,
  "currencyCode" TEXT,
  "paddleTransactionId" TEXT,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AdjustmentLedger" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "purchaseId" TEXT,
  "paddleAdjustmentId" TEXT,
  "paddleTransactionId" TEXT,
  "paddleSubscriptionId" TEXT,
  "action" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "reason" TEXT,
  "currencyCode" TEXT,
  "amountMinor" INTEGER,
  "raw" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AdjustmentLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BillingPurchase_paddleTransactionId_key" ON "BillingPurchase"("paddleTransactionId");
CREATE INDEX IF NOT EXISTS "BillingPurchase_businessId_createdAt_idx" ON "BillingPurchase"("businessId", "createdAt");
CREATE INDEX IF NOT EXISTS "BillingPurchase_productKind_status_idx" ON "BillingPurchase"("productKind", "status");
CREATE INDEX IF NOT EXISTS "BillingPurchase_paddleSubscriptionId_idx" ON "BillingPurchase"("paddleSubscriptionId");

CREATE INDEX IF NOT EXISTS "PaymentAttempt_businessId_createdAt_idx" ON "PaymentAttempt"("businessId", "createdAt");
CREATE INDEX IF NOT EXISTS "PaymentAttempt_purchaseId_idx" ON "PaymentAttempt"("purchaseId");
CREATE INDEX IF NOT EXISTS "PaymentAttempt_paddleTransactionId_idx" ON "PaymentAttempt"("paddleTransactionId");

CREATE UNIQUE INDEX IF NOT EXISTS "AdjustmentLedger_paddleAdjustmentId_key" ON "AdjustmentLedger"("paddleAdjustmentId");
CREATE INDEX IF NOT EXISTS "AdjustmentLedger_businessId_createdAt_idx" ON "AdjustmentLedger"("businessId", "createdAt");
CREATE INDEX IF NOT EXISTS "AdjustmentLedger_purchaseId_idx" ON "AdjustmentLedger"("purchaseId");
CREATE INDEX IF NOT EXISTS "AdjustmentLedger_paddleTransactionId_idx" ON "AdjustmentLedger"("paddleTransactionId");

ALTER TABLE "BillingPurchase"
  ADD CONSTRAINT "BillingPurchase_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaymentAttempt"
  ADD CONSTRAINT "PaymentAttempt_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaymentAttempt"
  ADD CONSTRAINT "PaymentAttempt_purchaseId_fkey"
  FOREIGN KEY ("purchaseId") REFERENCES "BillingPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AdjustmentLedger"
  ADD CONSTRAINT "AdjustmentLedger_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AdjustmentLedger"
  ADD CONSTRAINT "AdjustmentLedger_purchaseId_fkey"
  FOREIGN KEY ("purchaseId") REFERENCES "BillingPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
