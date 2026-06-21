-- Drop two unused models left behind from the rolled-back Paddle integration.
-- Discount: 0 rows, 0 code references (Coupon covers per-business discounts).
-- PaddleSyncJob: 0 rows, 0 code references.
-- DiscountType enum is kept because Coupon.discountType still uses it.

DROP TABLE IF EXISTS "Discount";
DROP TABLE IF EXISTS "PaddleSyncJob";
DROP TYPE  IF EXISTS "DiscountCycle";
DROP TYPE  IF EXISTS "PaddleSyncStatus";
