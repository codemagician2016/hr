-- Human-friendly 8-digit business code (nullable; backfilled post-deploy).
ALTER TABLE "Business" ADD COLUMN "shortId" TEXT;
CREATE UNIQUE INDEX "Business_shortId_key" ON "Business"("shortId");
