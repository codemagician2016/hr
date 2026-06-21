-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "billingModel" TEXT NOT NULL DEFAULT 'SUBSCRIPTION',
ADD COLUMN     "lastChargeAttemptAt" TIMESTAMP(3),
ADD COLUMN     "mandateMaxAmount" INTEGER,
ADD COLUMN     "mandateMethod" TEXT,
ADD COLUMN     "mandateStatus" TEXT,
ADD COLUMN     "nextChargeAt" TIMESTAMP(3),
ADD COLUMN     "preDebitNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "razorpayTokenId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_razorpayTokenId_key" ON "Subscription"("razorpayTokenId");

