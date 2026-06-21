ALTER TABLE "AdminCoupon" ADD COLUMN IF NOT EXISTS "paddleDiscountId" TEXT;
ALTER TABLE "AdminCoupon" ADD COLUMN IF NOT EXISTS "paddleDiscountStatus" TEXT;
CREATE INDEX IF NOT EXISTS "AdminCoupon_paddleDiscountId_idx" ON "AdminCoupon"("paddleDiscountId");
