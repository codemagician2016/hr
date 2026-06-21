ALTER TABLE "Subscription"
  ADD COLUMN "pastDueSince" TIMESTAMP(3),
  ADD COLUMN "accessGraceUntil" TIMESTAMP(3);

ALTER TABLE "Domain"
  ADD COLUMN "registrationPaddleTransactionId" TEXT,
  ADD COLUMN "renewalPaddleTransactionId" TEXT,
  ADD COLUMN "renewalPaymentStatus" TEXT,
  ADD COLUMN "renewalPaymentDueAt" TIMESTAMP(3),
  ADD COLUMN "renewalYears" INTEGER;

CREATE UNIQUE INDEX "Domain_registrationPaddleTransactionId_key" ON "Domain"("registrationPaddleTransactionId");
CREATE UNIQUE INDEX "Domain_renewalPaddleTransactionId_key" ON "Domain"("renewalPaddleTransactionId");
CREATE INDEX "Domain_renewalPaymentStatus_updatedAt_idx" ON "Domain"("renewalPaymentStatus", "updatedAt");
