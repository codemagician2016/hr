-- Feature 20 — Investment-Proof Submission + HR Verification workflow (India).
-- Additive only: two new tables + three new enums + indexes + FKs. Nothing on
-- StatutoryProfile (the declared snapshot) changes — proofs carry the EVIDENCE +
-- the VERIFIED truth, and the window carries the per-FY TDS lock primitive.

-- CreateEnum
CREATE TYPE "DeclarationWindowStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'LOCKED');

-- CreateEnum
CREATE TYPE "ProofStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ProofClaimType" AS ENUM ('SEC_80C', 'SEC_80D', 'SEC_80CCD1B', 'SEC_80TTA', 'SEC_24B_HOME_LOAN', 'HRA_RENT', 'OTHER_VIA');

-- CreateTable
CREATE TABLE "InvestmentDeclarationWindow" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "financialYear" VARCHAR(7) NOT NULL,
    "countryCode" CHAR(2) NOT NULL DEFAULT 'IN',
    "opensAt" DATE NOT NULL,
    "closesAt" DATE NOT NULL,
    "proofDeadline" DATE NOT NULL,
    "status" "DeclarationWindowStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvestmentDeclarationWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestmentProof" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "windowId" TEXT NOT NULL,
    "financialYear" VARCHAR(7) NOT NULL,
    "claimType" "ProofClaimType" NOT NULL,
    "subSection" VARCHAR(16),
    "declaredAmount" DECIMAL(15,2) NOT NULL,
    "verifiedAmount" DECIMAL(15,2),
    "fileUrl" TEXT NOT NULL,
    "fileHash" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "originalName" TEXT,
    "landlordName" TEXT,
    "landlordPan" CHAR(10),
    "rentMonthsCovered" INTEGER,
    "status" "ProofStatus" NOT NULL DEFAULT 'PENDING',
    "rejectReason" TEXT,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvestmentProof_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvestmentDeclarationWindow_businessId_status_idx" ON "InvestmentDeclarationWindow"("businessId", "status");

-- CreateIndex
CREATE INDEX "InvestmentDeclarationWindow_businessId_proofDeadline_idx" ON "InvestmentDeclarationWindow"("businessId", "proofDeadline");

-- CreateIndex
CREATE UNIQUE INDEX "InvestmentDeclarationWindow_businessId_financialYear_countr_key" ON "InvestmentDeclarationWindow"("businessId", "financialYear", "countryCode");

-- CreateIndex
CREATE INDEX "InvestmentProof_businessId_employeeId_financialYear_idx" ON "InvestmentProof"("businessId", "employeeId", "financialYear");

-- CreateIndex
CREATE INDEX "InvestmentProof_businessId_windowId_status_idx" ON "InvestmentProof"("businessId", "windowId", "status");

-- CreateIndex
CREATE INDEX "InvestmentProof_businessId_employeeId_claimType_idx" ON "InvestmentProof"("businessId", "employeeId", "claimType");

-- AddForeignKey
ALTER TABLE "InvestmentDeclarationWindow" ADD CONSTRAINT "InvestmentDeclarationWindow_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentProof" ADD CONSTRAINT "InvestmentProof_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentProof" ADD CONSTRAINT "InvestmentProof_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentProof" ADD CONSTRAINT "InvestmentProof_windowId_fkey" FOREIGN KEY ("windowId") REFERENCES "InvestmentDeclarationWindow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
