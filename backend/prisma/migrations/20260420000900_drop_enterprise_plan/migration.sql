-- Retire the Enterprise tier from the pricing catalogue (2026-04-20 decision).
-- PricingTier.slug='enterprise' is deleted outright; its TierPrice and
-- TierFeature children cascade automatically. The legacy Plan row (if any)
-- is archived instead of deleted so existing Subscription.planId FKs stay
-- valid — a safety net, since this is pre-launch and no paid subs exist yet.

DELETE FROM "PricingTier" WHERE "slug" = 'enterprise';

UPDATE "Plan" SET "isActive" = false WHERE "slug" = 'enterprise';
