-- Business.deliveryMode — how home delivery is offered, independent of the
-- pickupEnabled (Click & Collect) switch.
--   'SCHEDULED' = customer picks a delivery time window (EcomDeliverySlot)
--   'ASAP'      = delivered as soon as possible, no time windows
--   'NONE'      = no home delivery (pickup-only)
--
-- Default ASAP so brand-new and no-slot tenants never render an empty
-- "pick a delivery slot" picker at checkout.
ALTER TABLE "Business" ADD COLUMN "deliveryMode" TEXT NOT NULL DEFAULT 'ASAP';

-- Back-compat: any tenant that already has at least one ACTIVE recurring or
-- one-off delivery slot is clearly running scheduled delivery — keep that
-- behaviour by setting them to SCHEDULED. Everyone else stays ASAP.
UPDATE "Business" b
SET "deliveryMode" = 'SCHEDULED'
WHERE EXISTS (
  SELECT 1 FROM "EcomDeliverySlot" s
  WHERE s."businessId" = b."id" AND s."isActive" = true
);
