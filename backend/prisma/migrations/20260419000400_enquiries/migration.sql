-- Enquiries — customer-submitted contact-form messages.
-- CreateEnum
CREATE TYPE "EnquiryStatus" AS ENUM ('NEW', 'READ', 'REPLIED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Enquiry" (
    "id"          TEXT         NOT NULL,
    "businessId"  TEXT         NOT NULL,
    "name"        TEXT         NOT NULL,
    "email"       TEXT,
    "phone"       TEXT,
    "subject"     TEXT,
    "message"     TEXT         NOT NULL,
    "status"      "EnquiryStatus" NOT NULL DEFAULT 'NEW',
    "ipAddress"   TEXT,
    "userAgent"   TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Enquiry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Enquiry_businessId_status_createdAt_idx" ON "Enquiry"("businessId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "Enquiry"
  ADD CONSTRAINT "Enquiry_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
