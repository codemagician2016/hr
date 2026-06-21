-- Sprint 1.4 — CRM tags & segments (Pro tier). Three new tables, additive.

CREATE TABLE "CustomerTag" (
  "id"         TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "color"      TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerTag_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerTag_businessId_name_key" ON "CustomerTag"("businessId", "name");
CREATE INDEX "CustomerTag_businessId_idx" ON "CustomerTag"("businessId");
ALTER TABLE "CustomerTag"
  ADD CONSTRAINT "CustomerTag_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CustomerTagAssignment" (
  "id"         TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "tagId"      TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerTagAssignment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerTagAssignment_customerId_tagId_key"
  ON "CustomerTagAssignment"("customerId", "tagId");
CREATE INDEX "CustomerTagAssignment_tagId_idx" ON "CustomerTagAssignment"("tagId");
ALTER TABLE "CustomerTagAssignment"
  ADD CONSTRAINT "CustomerTagAssignment_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerTagAssignment"
  ADD CONSTRAINT "CustomerTagAssignment_tagId_fkey"
  FOREIGN KEY ("tagId") REFERENCES "CustomerTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CustomerSegment" (
  "id"         TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "filter"     JSONB NOT NULL DEFAULT '{}',
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerSegment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CustomerSegment_businessId_idx" ON "CustomerSegment"("businessId");
ALTER TABLE "CustomerSegment"
  ADD CONSTRAINT "CustomerSegment_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
