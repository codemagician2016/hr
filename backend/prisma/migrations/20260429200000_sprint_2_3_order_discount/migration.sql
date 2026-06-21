-- Sprint 2.3 — Discount codes on ECOMMERCE checkout. Two columns added
-- to Order; existing rows get default 0 / NULL.

ALTER TABLE "Order"
  ADD COLUMN "couponCode"    TEXT,
  ADD COLUMN "discountMinor" INTEGER NOT NULL DEFAULT 0;
