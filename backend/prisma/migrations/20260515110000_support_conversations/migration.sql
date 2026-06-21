CREATE TABLE "SupportConversation" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "subject" TEXT,
  "visitorName" TEXT,
  "visitorEmail" TEXT,
  "visitorPhone" TEXT,
  "visitorToken" TEXT,
  "customerId" TEXT,
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantReadAt" TIMESTAMP(3),
  "platformReadAt" TIMESTAMP(3),
  "visitorReadAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupportConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SupportMessage" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "senderType" TEXT NOT NULL,
  "userId" TEXT,
  "customerId" TEXT,
  "senderName" TEXT,
  "senderEmail" TEXT,
  "body" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupportConversation_businessId_kind_status_lastMessageAt_idx" ON "SupportConversation"("businessId", "kind", "status", "lastMessageAt");
CREATE INDEX "SupportConversation_customerId_lastMessageAt_idx" ON "SupportConversation"("customerId", "lastMessageAt");
CREATE INDEX "SupportMessage_conversationId_createdAt_idx" ON "SupportMessage"("conversationId", "createdAt");
CREATE INDEX "SupportMessage_businessId_createdAt_idx" ON "SupportMessage"("businessId", "createdAt");

ALTER TABLE "SupportConversation"
  ADD CONSTRAINT "SupportConversation_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportConversation"
  ADD CONSTRAINT "SupportConversation_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SupportMessage"
  ADD CONSTRAINT "SupportMessage_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportMessage"
  ADD CONSTRAINT "SupportMessage_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportMessage"
  ADD CONSTRAINT "SupportMessage_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SupportMessage"
  ADD CONSTRAINT "SupportMessage_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
