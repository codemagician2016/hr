-- AlterTable
ALTER TABLE "User" ADD COLUMN     "consultationFee" DOUBLE PRECISION,
ADD COLUMN     "experienceYears" INTEGER,
ADD COLUMN     "languages" TEXT,
ADD COLUMN     "qualification" TEXT,
ADD COLUMN     "registrationNumber" TEXT,
ADD COLUMN     "speciality" TEXT;

-- AlterTable
ALTER TABLE "AppointmentPrescription" ADD COLUMN     "doctorSnapshotJson" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'DRAFT';

-- CreateTable
CREATE TABLE "AppointmentInvoice" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "currency" TEXT,
    "lineItemsJson" TEXT NOT NULL,
    "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxLabel" TEXT,
    "patientName" TEXT,
    "patientContact" TEXT,
    "snapshotJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RxTemplate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdById" TEXT,
    "name" TEXT NOT NULL,
    "medicinesJson" TEXT NOT NULL,
    "clinicalJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RxTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentInvoice_appointmentId_key" ON "AppointmentInvoice"("appointmentId");

-- CreateIndex
CREATE INDEX "AppointmentInvoice_businessId_issuedAt_idx" ON "AppointmentInvoice"("businessId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentInvoice_businessId_invoiceNumber_key" ON "AppointmentInvoice"("businessId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "RxTemplate_businessId_idx" ON "RxTemplate"("businessId");

-- AddForeignKey
ALTER TABLE "AppointmentInvoice" ADD CONSTRAINT "AppointmentInvoice_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

