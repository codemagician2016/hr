-- Phase A: domain-reseller foundation.
-- This keeps purchased / transferred / BYOD domains separate from the
-- legacy Subscription.customDomain fields, so the new reseller workflow can
-- evolve without breaking existing custom-domain routing.

CREATE TYPE "Registrar" AS ENUM ('RESELLER_CLUB', '_1API', 'BYOD');

CREATE TYPE "DomainStatus" AS ENUM (
  'PENDING',
  'ACTIVE',
  'EXPIRING',
  'EXPIRED',
  'TRANSFER_IN_PENDING',
  'TRANSFER_OUT_PENDING',
  'BYOD',
  'FAILED',
  'LOCKED'
);

CREATE TABLE "Domain" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "tld" TEXT NOT NULL,
  "registrar" "Registrar" NOT NULL,
  "registrarRef" TEXT,
  "status" "DomainStatus" NOT NULL,
  "statusMessage" TEXT,
  "registeredAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "autoRenew" BOOLEAN NOT NULL DEFAULT true,
  "privacyEnabled" BOOLEAN NOT NULL DEFAULT false,
  "trusteeEnabled" BOOLEAN NOT NULL DEFAULT false,
  "wholesaleMinor" INTEGER NOT NULL,
  "retailMinor" INTEGER NOT NULL,
  "renewalRetailMinor" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "customHostnameId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DomainPricing" (
  "tld" TEXT NOT NULL,
  "registrar" "Registrar" NOT NULL,
  "wholesaleMinor" INTEGER NOT NULL,
  "retailMinor" INTEGER NOT NULL,
  "renewalWholesaleMinor" INTEGER,
  "renewalRetailMinor" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "isAvailable" BOOLEAN NOT NULL DEFAULT true,
  "requiresTrustee" BOOLEAN NOT NULL DEFAULT false,
  "notes" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DomainPricing_pkey" PRIMARY KEY ("tld")
);

CREATE UNIQUE INDEX "Domain_name_key" ON "Domain"("name");
CREATE INDEX "Domain_businessId_idx" ON "Domain"("businessId");
CREATE INDEX "Domain_expiresAt_status_idx" ON "Domain"("expiresAt", "status");
CREATE INDEX "DomainPricing_registrar_idx" ON "DomainPricing"("registrar");
CREATE INDEX "DomainPricing_isAvailable_idx" ON "DomainPricing"("isAvailable");

ALTER TABLE "Domain"
  ADD CONSTRAINT "Domain_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
