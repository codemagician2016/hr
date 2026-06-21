-- Sprint 2.1 + 2.2 — Payment provider linked accounts (Razorpay Route + Stripe Connect)

CREATE TABLE "BusinessPaymentAccount" (
  "id"             TEXT NOT NULL,
  "businessId"     TEXT NOT NULL,
  "provider"       TEXT NOT NULL,
  "accountId"      TEXT NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'PENDING',
  "platformFeePct" DECIMAL(5, 2) NOT NULL DEFAULT 2.5,
  "metadata"       JSONB,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessPaymentAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BusinessPaymentAccount_businessId_provider_key"
  ON "BusinessPaymentAccount"("businessId", "provider");
CREATE INDEX "BusinessPaymentAccount_businessId_idx"
  ON "BusinessPaymentAccount"("businessId");
ALTER TABLE "BusinessPaymentAccount"
  ADD CONSTRAINT "BusinessPaymentAccount_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
