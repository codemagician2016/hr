-- Per-vertical pricing tier support.
--
-- Adds PricingTier.vertical so each of the 3 product verticals (STATIC /
-- APPOINTMENT / ECOMMERCE) can have its own 4-tier ladder. Backfill: every
-- existing tier (Free / Starter / Professional / Business) was created for
-- the appointment-only product, so they all default to APPOINTMENT and the
-- existing customer-facing pricing page keeps working unchanged.
--
-- New e-commerce + static tiers get inserted later via super-admin UI or a
-- follow-up seed. This migration is purely additive.

ALTER TABLE "PricingTier" ADD COLUMN "vertical" TEXT NOT NULL DEFAULT 'APPOINTMENT';

-- Lookup index: pricing-page query is "active tiers for vertical X, sorted".
-- Covers that exact pattern.
CREATE INDEX "PricingTier_vertical_isActive_sortOrder_idx"
  ON "PricingTier"("vertical", "isActive", "sortOrder");
