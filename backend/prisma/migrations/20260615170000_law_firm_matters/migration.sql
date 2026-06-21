-- CreateTable
CREATE TABLE "Matter" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "matterNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "practiceArea" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "feeBasis" TEXT NOT NULL DEFAULT 'HOURLY',
    "defaultRate" DOUBLE PRECISION,
    "fixedFee" DOUBLE PRECISION,
    "currency" TEXT,
    "engagementStatus" TEXT NOT NULL DEFAULT 'NONE',
    "engagementDocId" TEXT,
    "engagementSentAt" TIMESTAMP(3),
    "engagementAcceptedAt" TIMESTAMP(3),
    "customerId" TEXT,
    "responsibleLawyerId" TEXT,
    "originAppointmentId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Matter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatterInvoice" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "matterId" TEXT NOT NULL,
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

    CONSTRAINT "MatterInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatterTimeEntry" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "matterId" TEXT NOT NULL,
    "userId" TEXT,
    "workedOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "narrative" TEXT,
    "billed" BOOLEAN NOT NULL DEFAULT false,
    "invoiceId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatterTimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatterDisbursement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "matterId" TEXT NOT NULL,
    "incurredOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "description" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "billed" BOOLEAN NOT NULL DEFAULT false,
    "invoiceId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatterDisbursement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustTransaction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "matterId" TEXT,
    "customerId" TEXT,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "balanceAfter" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "relatedInvoiceId" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrustTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Matter_originAppointmentId_key" ON "Matter"("originAppointmentId");

-- CreateIndex
CREATE INDEX "Matter_businessId_status_openedAt_idx" ON "Matter"("businessId", "status", "openedAt");

-- CreateIndex
CREATE INDEX "Matter_businessId_customerId_idx" ON "Matter"("businessId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Matter_businessId_matterNumber_key" ON "Matter"("businessId", "matterNumber");

-- CreateIndex
CREATE INDEX "MatterInvoice_businessId_status_issuedAt_idx" ON "MatterInvoice"("businessId", "status", "issuedAt");

-- CreateIndex
CREATE INDEX "MatterInvoice_matterId_idx" ON "MatterInvoice"("matterId");

-- CreateIndex
CREATE UNIQUE INDEX "MatterInvoice_businessId_invoiceNumber_key" ON "MatterInvoice"("businessId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "MatterTimeEntry_businessId_matterId_billed_idx" ON "MatterTimeEntry"("businessId", "matterId", "billed");

-- CreateIndex
CREATE INDEX "MatterDisbursement_businessId_matterId_billed_idx" ON "MatterDisbursement"("businessId", "matterId", "billed");

-- CreateIndex
CREATE INDEX "TrustTransaction_businessId_createdAt_idx" ON "TrustTransaction"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "TrustTransaction_matterId_createdAt_idx" ON "TrustTransaction"("matterId", "createdAt");

-- AddForeignKey
ALTER TABLE "Matter" ADD CONSTRAINT "Matter_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Matter" ADD CONSTRAINT "Matter_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Matter" ADD CONSTRAINT "Matter_responsibleLawyerId_fkey" FOREIGN KEY ("responsibleLawyerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Matter" ADD CONSTRAINT "Matter_originAppointmentId_fkey" FOREIGN KEY ("originAppointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatterInvoice" ADD CONSTRAINT "MatterInvoice_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatterTimeEntry" ADD CONSTRAINT "MatterTimeEntry_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatterDisbursement" ADD CONSTRAINT "MatterDisbursement_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustTransaction" ADD CONSTRAINT "TrustTransaction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustTransaction" ADD CONSTRAINT "TrustTransaction_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

