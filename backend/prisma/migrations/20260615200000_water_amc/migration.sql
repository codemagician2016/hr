-- CreateTable
CREATE TABLE "InstalledUnit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "brand" TEXT,
    "model" TEXT,
    "serial" TEXT,
    "purifierType" TEXT,
    "waterSource" TEXT,
    "installedAt" TIMESTAMP(3),
    "warrantyUntil" TIMESTAMP(3),
    "addressLine" TEXT,
    "pincode" TEXT,
    "lastTds" INTEGER,
    "notes" TEXT,
    "originAppointmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstalledUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmcContract" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "contractNumber" TEXT NOT NULL,
    "customerId" TEXT,
    "installedUnitId" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'BASIC',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "price" DOUBLE PRECISION,
    "currency" TEXT,
    "visitsIncluded" INTEGER NOT NULL DEFAULT 0,
    "visitsUsed" INTEGER NOT NULL DEFAULT 0,
    "nextVisitDueAt" TIMESTAMP(3),
    "responsibleTechnicianId" TEXT,
    "originAppointmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmcContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceVisit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "amcContractId" TEXT,
    "installedUnitId" TEXT,
    "appointmentId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'PREVENTIVE',
    "scheduledFor" TIMESTAMP(3),
    "dueBy" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "technicianId" TEXT,
    "tdsBefore" INTEGER,
    "tdsAfter" INTEGER,
    "partsReplacedJson" TEXT,
    "reportDocId" TEXT,
    "notes" TEXT,
    "billed" BOOLEAN NOT NULL DEFAULT false,
    "invoiceId" TEXT,
    "completedAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmcInvoice" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "amcContractId" TEXT,
    "customerId" TEXT,
    "invoiceNumber" TEXT NOT NULL,
    "currency" TEXT,
    "lineItemsJson" TEXT NOT NULL,
    "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxLabel" TEXT,
    "amountPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "dueDate" TIMESTAMP(3),
    "clientName" TEXT,
    "clientContact" TEXT,
    "snapshotJson" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmcInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InstalledUnit_originAppointmentId_key" ON "InstalledUnit"("originAppointmentId");

-- CreateIndex
CREATE INDEX "InstalledUnit_businessId_pincode_idx" ON "InstalledUnit"("businessId", "pincode");

-- CreateIndex
CREATE INDEX "InstalledUnit_businessId_customerId_idx" ON "InstalledUnit"("businessId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "AmcContract_originAppointmentId_key" ON "AmcContract"("originAppointmentId");

-- CreateIndex
CREATE INDEX "AmcContract_businessId_status_endDate_idx" ON "AmcContract"("businessId", "status", "endDate");

-- CreateIndex
CREATE INDEX "AmcContract_businessId_nextVisitDueAt_idx" ON "AmcContract"("businessId", "nextVisitDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "AmcContract_businessId_contractNumber_key" ON "AmcContract"("businessId", "contractNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceVisit_appointmentId_key" ON "ServiceVisit"("appointmentId");

-- CreateIndex
CREATE INDEX "ServiceVisit_businessId_status_scheduledFor_idx" ON "ServiceVisit"("businessId", "status", "scheduledFor");

-- CreateIndex
CREATE INDEX "ServiceVisit_businessId_dueBy_idx" ON "ServiceVisit"("businessId", "dueBy");

-- CreateIndex
CREATE INDEX "ServiceVisit_amcContractId_idx" ON "ServiceVisit"("amcContractId");

-- CreateIndex
CREATE INDEX "AmcInvoice_businessId_status_issuedAt_idx" ON "AmcInvoice"("businessId", "status", "issuedAt");

-- CreateIndex
CREATE INDEX "AmcInvoice_amcContractId_idx" ON "AmcInvoice"("amcContractId");

-- CreateIndex
CREATE UNIQUE INDEX "AmcInvoice_businessId_invoiceNumber_key" ON "AmcInvoice"("businessId", "invoiceNumber");

-- AddForeignKey
ALTER TABLE "InstalledUnit" ADD CONSTRAINT "InstalledUnit_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstalledUnit" ADD CONSTRAINT "InstalledUnit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstalledUnit" ADD CONSTRAINT "InstalledUnit_originAppointmentId_fkey" FOREIGN KEY ("originAppointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcContract" ADD CONSTRAINT "AmcContract_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcContract" ADD CONSTRAINT "AmcContract_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcContract" ADD CONSTRAINT "AmcContract_installedUnitId_fkey" FOREIGN KEY ("installedUnitId") REFERENCES "InstalledUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcContract" ADD CONSTRAINT "AmcContract_responsibleTechnicianId_fkey" FOREIGN KEY ("responsibleTechnicianId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcContract" ADD CONSTRAINT "AmcContract_originAppointmentId_fkey" FOREIGN KEY ("originAppointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVisit" ADD CONSTRAINT "ServiceVisit_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVisit" ADD CONSTRAINT "ServiceVisit_amcContractId_fkey" FOREIGN KEY ("amcContractId") REFERENCES "AmcContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVisit" ADD CONSTRAINT "ServiceVisit_installedUnitId_fkey" FOREIGN KEY ("installedUnitId") REFERENCES "InstalledUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVisit" ADD CONSTRAINT "ServiceVisit_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVisit" ADD CONSTRAINT "ServiceVisit_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcInvoice" ADD CONSTRAINT "AmcInvoice_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcInvoice" ADD CONSTRAINT "AmcInvoice_amcContractId_fkey" FOREIGN KEY ("amcContractId") REFERENCES "AmcContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

