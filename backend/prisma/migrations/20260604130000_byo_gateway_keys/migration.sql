-- BYO gateway: store the tenant's OWN Razorpay credentials (secret encrypted
-- at rest). When set, buyer payments run on the tenant's account directly.
ALTER TABLE "BusinessPaymentAccount" ADD COLUMN IF NOT EXISTS "keyId" TEXT;
ALTER TABLE "BusinessPaymentAccount" ADD COLUMN IF NOT EXISTS "keySecretEnc" TEXT;
