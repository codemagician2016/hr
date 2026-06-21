ALTER TABLE "Business"
  ADD COLUMN "billingPurchaserType" TEXT NOT NULL DEFAULT 'INDIVIDUAL',
  ADD COLUMN "billingBusinessName" TEXT,
  ADD COLUMN "billingContactName" TEXT,
  ADD COLUMN "billingEmail" TEXT,
  ADD COLUMN "billingTaxId" TEXT,
  ADD COLUMN "billingAddressLine1" TEXT,
  ADD COLUMN "billingAddressLine2" TEXT,
  ADD COLUMN "billingCity" TEXT,
  ADD COLUMN "billingState" TEXT,
  ADD COLUMN "billingPostalCode" TEXT,
  ADD COLUMN "billingCountry" TEXT;
