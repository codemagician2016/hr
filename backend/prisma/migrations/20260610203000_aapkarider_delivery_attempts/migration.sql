-- AapkaRider failed-attempt recovery.
-- Tracks how many delivery attempts were made and when the next retry should
-- happen, without relying on free-text notes.

ALTER TABLE "EcomDeliveryRequest"
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
