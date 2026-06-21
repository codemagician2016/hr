-- CreateTable
CREATE TABLE "Mailbox" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "statusMessage" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'ZOHO',
    "zohoZoid" TEXT,
    "zohoAccountId" TEXT,
    "dnsManaged" BOOLEAN NOT NULL DEFAULT false,
    "deliveredTo" TEXT,
    "credentialsSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mailbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Mailbox_businessId_idx" ON "Mailbox"("businessId");

-- CreateIndex
CREATE INDEX "Mailbox_status_idx" ON "Mailbox"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_businessId_address_key" ON "Mailbox"("businessId", "address");

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
