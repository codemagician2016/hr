-- Schema-drift recovery: paddleCustomerId + paddleSubscriptionId were
-- declared in schema.prisma after the April-2026 Paddle revert (the comment
-- in the model claimed the columns survived the revert), but no migration
-- ever recreated them in the DB. Result: every Subscription query in PM2
-- threw `column does not exist`, which blocked super-admin login flows that
-- touch Subscription. This adds them back idempotently.

ALTER TABLE "Subscription"
  ADD COLUMN IF NOT EXISTS "paddleCustomerId" TEXT,
  ADD COLUMN IF NOT EXISTS "paddleSubscriptionId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_paddleSubscriptionId_key"
  ON "Subscription"("paddleSubscriptionId");
