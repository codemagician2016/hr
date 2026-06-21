-- Store-level FLAT delivery (deliver-anywhere baseline).
-- Additive + non-breaking (defaulted / nullable columns).
-- Used when a shopper's address matches no EcomDeliveryZone, so checkout can
-- compute a server-side delivery charge + ETA instead of trusting the client.

ALTER TABLE "Business" ADD COLUMN "flatDeliveryFeeMinor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Business" ADD COLUMN "flatFreeDeliveryThresholdMinor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Business" ADD COLUMN "deliveryEtaMinutes" INTEGER;
