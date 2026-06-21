ALTER TABLE "Business"
  ADD COLUMN "paddleBillingAddressId" TEXT,
  ADD COLUMN "paddleBillingBusinessId" TEXT;

ALTER TABLE "Subscription"
  ADD COLUMN "lastPaddleEventAt" TIMESTAMP(3),
  ADD COLUMN "lastPaddleEventId" TEXT;

ALTER TABLE "Mailbox"
  ADD COLUMN "billingStatus" TEXT,
  ADD COLUMN "billingCycle" TEXT,
  ADD COLUMN "billingQuantity" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "paddleCustomerId" TEXT,
  ADD COLUMN "paddleSubscriptionId" TEXT,
  ADD COLUMN "paddleTransactionId" TEXT;

CREATE UNIQUE INDEX "Mailbox_paddleSubscriptionId_key" ON "Mailbox"("paddleSubscriptionId");
CREATE INDEX "Mailbox_billingStatus_idx" ON "Mailbox"("billingStatus");
CREATE INDEX "Mailbox_paddleTransactionId_idx" ON "Mailbox"("paddleTransactionId");

CREATE TABLE "PaddleBillingSubscription" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "productKind" TEXT NOT NULL,
  "productRef" TEXT,
  "status" TEXT NOT NULL,
  "billingCycle" TEXT,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "currencyCode" TEXT,
  "unitAmountMinor" INTEGER,
  "paddleCustomerId" TEXT,
  "paddleSubscriptionId" TEXT,
  "paddleTransactionId" TEXT,
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "nextBilledAt" TIMESTAMP(3),
  "scheduledChangeAction" TEXT,
  "lastPaddleEventAt" TIMESTAMP(3),
  "lastPaddleEventId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PaddleBillingSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaddleBillingSubscription_paddleSubscriptionId_key" ON "PaddleBillingSubscription"("paddleSubscriptionId");
CREATE UNIQUE INDEX "PaddleBillingSubscription_businessId_productKind_productRef_key" ON "PaddleBillingSubscription"("businessId", "productKind", "productRef");
CREATE INDEX "PaddleBillingSubscription_businessId_productKind_idx" ON "PaddleBillingSubscription"("businessId", "productKind");
CREATE INDEX "PaddleBillingSubscription_paddleCustomerId_idx" ON "PaddleBillingSubscription"("paddleCustomerId");
CREATE INDEX "PaddleBillingSubscription_paddleTransactionId_idx" ON "PaddleBillingSubscription"("paddleTransactionId");
CREATE INDEX "PaddleBillingSubscription_status_updatedAt_idx" ON "PaddleBillingSubscription"("status", "updatedAt");

ALTER TABLE "PaddleBillingSubscription"
  ADD CONSTRAINT "PaddleBillingSubscription_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
