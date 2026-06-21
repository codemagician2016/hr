-- Make PricingTier store the full marketing-card content (tagline, feature
-- bullets, CTA label/href, highlighted flag, included-staff count) so the
-- landing page renders straight from super-admin — no more hardcoded PLANS.
--
-- Renames the Prisma-generated relation field backing for TierFeature from
-- "features" to "tierFeatures" so the new text-array column "features" can
-- live alongside the structured feature-entitlement table.

-- 1. Add the new content columns (all nullable or with safe defaults so the
--    migration works on an existing populated table).
ALTER TABLE "PricingTier"
  ADD COLUMN "tagline"       TEXT,
  ADD COLUMN "features"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "ctaLabel"      TEXT,
  ADD COLUMN "ctaHref"       TEXT,
  ADD COLUMN "highlighted"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "includedStaff" INTEGER;

-- 2. Seed / backfill the four canonical tiers with the copy that was already
--    hardcoded on the marketing landing page. Super-admin can overwrite any
--    of these fields afterwards through the UI.
--
--    Each UPDATE only touches a slug's row, and only sets a column if it's
--    empty — so an admin who already set, say, a custom tagline won't lose it.

-- Free
UPDATE "PricingTier"
SET
  "tagline"       = COALESCE(NULLIF("tagline", ''),       'Get online and take your first booking today.'),
  "ctaLabel"      = COALESCE(NULLIF("ctaLabel", ''),      'Start free'),
  "features"      = CASE WHEN COALESCE(array_length("features", 1), 0) = 0 THEN ARRAY[
    '1 staff member',
    'Up to 50 bookings / month',
    'Free .appointease.in subdomain',
    'Email reminders',
    '"Powered by AppointEase" branding',
    'Connect your own Stripe / Razorpay account'
  ] ELSE "features" END
WHERE "slug" = 'free';

-- Starter
UPDATE "PricingTier"
SET
  "tagline"       = COALESCE(NULLIF("tagline", ''),       'For the solo practitioner ready to look professional.'),
  "ctaLabel"      = COALESCE(NULLIF("ctaLabel", ''),      'Start free'),
  "features"      = CASE WHEN COALESCE(array_length("features", 1), 0) = 0 THEN ARRAY[
    'Everything in Free',
    'Up to 2 staff members',
    'Unlimited bookings',
    'Your own brand domain (yours.com)',
    'Branding watermark removed',
    '200 SMS reminders / month',
    'Basic CRM & client notes',
    'Google & Apple calendar sync'
  ] ELSE "features" END
WHERE "slug" = 'starter';

-- Professional (the "highlighted" / most-popular card)
UPDATE "PricingTier"
SET
  "tagline"       = COALESCE(NULLIF("tagline", ''),       'Built for teams.'),
  "ctaLabel"      = COALESCE(NULLIF("ctaLabel", ''),      'Start free'),
  "highlighted"   = true,
  "includedStaff" = COALESCE("includedStaff", 10),
  "features"      = CASE WHEN COALESCE(array_length("features", 1), 0) = 0 THEN ARRAY[
    'Everything in Starter',
    'Up to 10 staff members included',
    'Service & staff routing',
    'Full CRM with tags & segments',
    'Marketing automation (birthdays, re-engagement)',
    'Advanced intake forms & file uploads',
    'Unlimited SMS reminders',
    'Analytics & reports',
    'Waiting list & multi-currency'
  ] ELSE "features" END
WHERE "slug" = 'professional';

-- Business
UPDATE "PricingTier"
SET
  "tagline"       = COALESCE(NULLIF("tagline", ''),       'Multi-location and group practices.'),
  "ctaLabel"      = COALESCE(NULLIF("ctaLabel", ''),      'Talk to sales'),
  "ctaHref"       = COALESCE(NULLIF("ctaHref", ''),       'mailto:sales@aapkatech.com'),
  "features"      = CASE WHEN COALESCE(array_length("features", 1), 0) = 0 THEN ARRAY[
    'Everything in Professional',
    'Unlimited staff',
    'Multi-location support',
    'Role-based access control (RBAC)',
    'API access & webhooks',
    'HIPAA / compliance add-ons',
    'Priority support',
    'Dedicated success manager'
  ] ELSE "features" END
WHERE "slug" = 'business';
