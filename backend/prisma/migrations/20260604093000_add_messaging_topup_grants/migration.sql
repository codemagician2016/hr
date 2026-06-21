CREATE TABLE IF NOT EXISTS "MessagingTopupGrant" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "cycle" TEXT NOT NULL,
    "amountUsd" DECIMAL(10,2) NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "paddleTransactionId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessagingTopupGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MessagingTopupGrant_paddleTransactionId_key"
    ON "MessagingTopupGrant"("paddleTransactionId");

CREATE INDEX IF NOT EXISTS "MessagingTopupGrant_businessId_cycle_idx"
    ON "MessagingTopupGrant"("businessId", "cycle");

CREATE INDEX IF NOT EXISTS "MessagingTopupGrant_purchaseId_idx"
    ON "MessagingTopupGrant"("purchaseId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'MessagingTopupGrant_businessId_fkey'
  ) THEN
    ALTER TABLE "MessagingTopupGrant"
      ADD CONSTRAINT "MessagingTopupGrant_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'MessagingTopupGrant_purchaseId_fkey'
  ) THEN
    ALTER TABLE "MessagingTopupGrant"
      ADD CONSTRAINT "MessagingTopupGrant_purchaseId_fkey"
      FOREIGN KEY ("purchaseId") REFERENCES "BillingPurchase"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
