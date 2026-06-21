-- Extend CouponRedemption to support ECOMMERCE orders + guest checkouts.
-- Existing APPOINTMENT redemptions keep working unchanged.
ALTER TABLE "CouponRedemption" ADD COLUMN "customerEmail" TEXT;
ALTER TABLE "CouponRedemption" ADD COLUMN "orderId" TEXT;

CREATE INDEX "CouponRedemption_couponId_customerEmail_idx" ON "CouponRedemption"("couponId", "customerEmail");
CREATE INDEX "CouponRedemption_orderId_idx" ON "CouponRedemption"("orderId");
