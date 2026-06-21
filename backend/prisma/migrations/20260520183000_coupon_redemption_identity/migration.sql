ALTER TABLE "CouponRedemption"
ADD COLUMN IF NOT EXISTS "customerPhone" TEXT,
ADD COLUMN IF NOT EXISTS "sessionId" TEXT;

CREATE INDEX IF NOT EXISTS "CouponRedemption_couponId_customerPhone_idx"
ON "CouponRedemption"("couponId", "customerPhone");

CREATE INDEX IF NOT EXISTS "CouponRedemption_couponId_sessionId_idx"
ON "CouponRedemption"("couponId", "sessionId");
