CREATE TABLE "AppointmentDocument" (
  "id" TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "createdById" TEXT,
  "type" TEXT NOT NULL,
  "title" TEXT,
  "recipientName" TEXT,
  "recipientContact" TEXT,
  "payloadJson" TEXT NOT NULL,
  "letterheadJson" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "issuedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AppointmentDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppointmentDocument_appointmentId_type_key" ON "AppointmentDocument"("appointmentId", "type");
CREATE INDEX "AppointmentDocument_businessId_createdAt_idx" ON "AppointmentDocument"("businessId", "createdAt");
CREATE INDEX "AppointmentDocument_createdById_idx" ON "AppointmentDocument"("createdById");

ALTER TABLE "AppointmentDocument"
  ADD CONSTRAINT "AppointmentDocument_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppointmentDocument"
  ADD CONSTRAINT "AppointmentDocument_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppointmentDocument"
  ADD CONSTRAINT "AppointmentDocument_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
