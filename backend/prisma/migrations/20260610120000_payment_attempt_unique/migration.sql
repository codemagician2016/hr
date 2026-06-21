-- B18: guarantee one PaymentAttempt row per (business, gateway txn id, status)
-- at the DB level, so a webhook retry / reconcile / gateway redelivery can never
-- create a duplicate payment-history row (the recorders previously relied only on
-- a racy find-first-then-create).
--
-- Defensive: collapse any existing duplicates FIRST (keep the most recent per
-- key) so CREATE UNIQUE INDEX can't fail on pre-existing rows. Rows with a NULL
-- paddleTransactionId are left untouched (Postgres treats NULLs as distinct).

DELETE FROM "PaymentAttempt" a
USING "PaymentAttempt" b
WHERE a."paddleTransactionId" IS NOT NULL
  AND a."businessId" = b."businessId"
  AND a."paddleTransactionId" = b."paddleTransactionId"
  AND a."status" = b."status"
  AND (a."createdAt" < b."createdAt" OR (a."createdAt" = b."createdAt" AND a."id" < b."id"));

CREATE UNIQUE INDEX "PaymentAttempt_businessId_paddleTransactionId_status_key"
  ON "PaymentAttempt" ("businessId", "paddleTransactionId", "status");
