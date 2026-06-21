-- Structured intake for the law_firm booking theme (1:1 with Appointment).
-- Additive: new table only; no changes to existing tables.

CREATE TABLE "LawFirmIntake" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "format" TEXT NOT NULL DEFAULT 'IN_PERSON',
  "matterType" TEXT,
  "matterSummary" TEXT,
  "opposingParty" TEXT,
  "deadline" TEXT,
  "existingClient" TEXT,
  "idDocumentType" TEXT,
  "referralSource" TEXT,
  "source" TEXT NOT NULL DEFAULT 'ONLINE',
  "conflictStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "conflictNotes" TEXT,
  "conflictCheckedById" TEXT,
  "conflictCheckedAt" TIMESTAMP(3),
  "conflictConsentAt" TIMESTAMP(3),
  "amlConsentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LawFirmIntake_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LawFirmIntake_appointmentId_key" ON "LawFirmIntake"("appointmentId");
CREATE INDEX "LawFirmIntake_businessId_conflictStatus_createdAt_idx" ON "LawFirmIntake"("businessId", "conflictStatus", "createdAt");

ALTER TABLE "LawFirmIntake"
  ADD CONSTRAINT "LawFirmIntake_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LawFirmIntake"
  ADD CONSTRAINT "LawFirmIntake_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
