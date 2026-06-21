-- ECOMMERCE multi-store / multi-region mode (2026-05-12).
--
-- Adds a tenant-level switch that controls how the storefront resolves
-- the shopper's delivery context:
--
--   OFF      — single-location tenant, no LocationPrompt (legacy default,
--              also covers APPOINTMENT / STATIC verticals).
--   CHAIN    — Pak'nSave-style; shopper picks a physical store.
--   REGIONAL — Shopify-Markets-style; shopper picks a region (city).
--   BOTH     — region first, store within region (international chain).
--
-- Default = 'OFF' so every existing tenant keeps its current UX. Tenants
-- opt in via the admin Settings panel. Storefront LocationGate reads
-- this from the tenant resolution payload.

ALTER TABLE "Business"
  ADD COLUMN "multiStoreMode" TEXT NOT NULL DEFAULT 'OFF';
