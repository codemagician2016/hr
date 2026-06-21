-- Multi-page CMS — Phase 1 schema (A4 from ROADMAP).
-- Adds:
--   1. Business.vertical column (default APPOINTMENT for existing tenants)
--   2. BusinessPage table for the multi-page CMS
-- Prerequisite for Phase E (static + e-commerce verticals).

-- 1. Business vertical column. Default APPOINTMENT keeps every existing
-- tenant on the current product without any data change.
ALTER TABLE "Business" ADD COLUMN "vertical" TEXT NOT NULL DEFAULT 'APPOINTMENT';

-- 2. BusinessPage table. Content is JSON blob (Postgres JSONB).
CREATE TABLE "BusinessPage" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "parentNav" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "content" JSONB NOT NULL DEFAULT '{}',
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessPage_pkey" PRIMARY KEY ("id")
);

-- Uniqueness: one slug per (businessId, parentNav). Two businesses can both
-- have "/services/haircut", but a single business can't have two.
CREATE UNIQUE INDEX "BusinessPage_businessId_parentNav_slug_key"
  ON "BusinessPage"("businessId", "parentNav", "slug");

-- Lookup index: storefront fetches "all published pages under nav X for
-- business Y, ordered by sortOrder". Covers that exact query.
CREATE INDEX "BusinessPage_businessId_parentNav_isPublished_sortOrder_idx"
  ON "BusinessPage"("businessId", "parentNav", "isPublished", "sortOrder");

-- FK with cascade — when a business is deleted, its pages go with it.
ALTER TABLE "BusinessPage"
  ADD CONSTRAINT "BusinessPage_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
