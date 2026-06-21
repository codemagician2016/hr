-- Subscription.activatedAt — the keystone of the billing state machine. Set the
-- first time a tenant reaches an entitling paid/trial state; never cleared. It
-- distinguishes a never-paid ONBOARDING placeholder (activatedAt NULL) from a
-- lapsed EXPIRED tenant (both sit on the free tier after a lapse/downgrade).
ALTER TABLE "Subscription" ADD COLUMN "activatedAt" TIMESTAMP(3);

-- Grandfather every tenant that has (or ever had) a real billing relationship so
-- no paying customer is thrown back into onboarding by the new gate. Never-paid
-- free placeholders match none of these → activatedAt stays NULL → onboarding.
UPDATE "Subscription" SET "activatedAt" = now()
WHERE "paddleSubscriptionId"   IS NOT NULL
   OR "stripeSubscriptionId"   IS NOT NULL
   OR "razorpaySubscriptionId" IS NOT NULL
   OR "pastDueSince"           IS NOT NULL
   OR "trialConvertedAt"       IS NOT NULL;
