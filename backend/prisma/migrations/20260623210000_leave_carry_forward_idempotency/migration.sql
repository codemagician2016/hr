-- Feature 6 — year-end carry-forward idempotency (review finding #1).
-- ADDITIVE: a nullable marker stamped on the SOURCE LeaveBalance when
-- runCarryForward rolls it into the next period. The in-tx re-guard skips a
-- balance whose carriedForwardAt is already set, so a re-run / operator
-- double-click / double-fired cron cannot double-lapse + double-carry.
ALTER TABLE "LeaveBalance" ADD COLUMN IF NOT EXISTS "carriedForwardAt" TIMESTAMP(3);
