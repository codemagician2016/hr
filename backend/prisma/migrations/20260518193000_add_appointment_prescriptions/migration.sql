CREATE TABLE "AppointmentPrescription" (
  "id" TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "createdById" TEXT,
  "patientName" TEXT,
  "patientContact" TEXT,
  "clinicalJson" TEXT NOT NULL,
  "medicinesJson" TEXT NOT NULL,
  "letterheadJson" TEXT,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AppointmentPrescription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppointmentPrescription_appointmentId_key" ON "AppointmentPrescription"("appointmentId");
CREATE INDEX "AppointmentPrescription_businessId_issuedAt_idx" ON "AppointmentPrescription"("businessId", "issuedAt");
CREATE INDEX "AppointmentPrescription_createdById_idx" ON "AppointmentPrescription"("createdById");

ALTER TABLE "AppointmentPrescription"
  ADD CONSTRAINT "AppointmentPrescription_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppointmentPrescription"
  ADD CONSTRAINT "AppointmentPrescription_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppointmentPrescription"
  ADD CONSTRAINT "AppointmentPrescription_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
