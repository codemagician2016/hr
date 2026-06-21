-- Buyer payments are pure pass-through: platform fee defaults to 0 (tenant keeps
-- 100%; Sitepresso monetizes via subscriptions). A per-tenant fee can still be set.
ALTER TABLE "BusinessPaymentAccount" ALTER COLUMN "platformFeePct" SET DEFAULT 0;
