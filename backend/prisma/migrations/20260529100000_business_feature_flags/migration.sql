-- Per-tenant feature flag overrides on Business. Admin can opt OUT of
-- features their plan tier enables (cannot enable beyond tier).
-- Shape: { "featureKey": boolean, ... }. NULL means "use catalog + tier defaults".
ALTER TABLE "Business" ADD COLUMN "featureFlags" JSONB;
