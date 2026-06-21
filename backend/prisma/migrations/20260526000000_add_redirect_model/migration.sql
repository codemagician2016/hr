-- CreateTable
CREATE TABLE "Redirect" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "fromPath" TEXT NOT NULL,
    "toPath" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL DEFAULT 301,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Redirect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Redirect_businessId_fromPath_key" ON "Redirect"("businessId", "fromPath");

-- CreateIndex
CREATE INDEX "Redirect_businessId_idx" ON "Redirect"("businessId");

-- AddForeignKey
ALTER TABLE "Redirect" ADD CONSTRAINT "Redirect_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
