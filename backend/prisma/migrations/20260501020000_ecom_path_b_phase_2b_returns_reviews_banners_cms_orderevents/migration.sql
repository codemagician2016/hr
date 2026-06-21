-- ECOMMERCE Path B Phase 2b (2026-05-01) — purely additive migration.
--
-- Customer-facing operations layer + storefront content:
--   * Returns: EcomReturn / EcomReturnItem / EcomReturnEvent + 4 enums
--   * Reviews: EcomReview + EcomReviewStatus enum
--   * Banners: EcomBanner + EcomBannerPlacement enum
--   * CMS:     EcomCmsBlock + 2 enums
--   * Per-order audit log: EcomOrderEvent
--
-- All new tables/enums; no existing column or constraint modifications.
-- STATIC + APPOINTMENT verticals are unaffected.
--
-- NOTE: existing global `MessageTemplate` covers ECOMMERCE notifications
-- via vertical='ECOMMERCE' — no separate EcomNotificationTemplate.
-- Existing `Coupon` covers ECOMMERCE discount codes; future per-location
-- and customer-segment extensions layer onto it directly.

-- ─── Enums ────────────────────────────────────────────────────────────────

CREATE TYPE "EcomReturnStatus" AS ENUM (
  'REQUESTED', 'APPROVED', 'REJECTED', 'COLLECTED', 'REFUNDED', 'CLOSED'
);

CREATE TYPE "EcomReturnReason" AS ENUM (
  'DAMAGED', 'WRONG_ITEM', 'EXPIRED', 'CHANGED_MIND', 'POOR_QUALITY',
  'NOT_AS_DESCRIBED', 'ARRIVED_LATE', 'OTHER'
);

CREATE TYPE "EcomReturnDisposition" AS ENUM (
  'PENDING', 'RESTOCK', 'SCRAP', 'RETURN_TO_SUPPLIER', 'HOLD_FOR_INSPECTION'
);

CREATE TYPE "EcomReviewStatus" AS ENUM (
  'PENDING', 'PUBLISHED', 'HIDDEN', 'REJECTED'
);

CREATE TYPE "EcomBannerPlacement" AS ENUM (
  'HOMEPAGE_HERO', 'HOMEPAGE_STRIP', 'CATEGORY_HERO',
  'CART_UPSELL', 'ACCOUNT_OFFER', 'CHECKOUT_BANNER'
);

CREATE TYPE "EcomCmsBlockType" AS ENUM (
  'HERO', 'FEATURED_COLLECTION', 'BESTSELLERS_AUTO', 'EDITORIAL_RICHTEXT',
  'RECIPE_LINKED', 'TESTIMONIAL_STRIP', 'CATEGORY_GRID', 'COUPON_CALLOUT'
);

CREATE TYPE "EcomCmsBlockStatus" AS ENUM (
  'DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED'
);

-- ─── EcomReturn + items + events ──────────────────────────────────────────

CREATE TABLE "EcomReturn" (
  "id"                TEXT NOT NULL,
  "businessId"        TEXT NOT NULL,
  "code"              TEXT NOT NULL,
  "orderId"           TEXT,
  "orderCode"         TEXT,
  "customerId"        TEXT,
  "customerName"      TEXT NOT NULL,
  "customerEmail"     TEXT NOT NULL,
  "status"            "EcomReturnStatus" NOT NULL DEFAULT 'REQUESTED',
  "reasonCategory"    "EcomReturnReason" NOT NULL,
  "reasonNote"        TEXT,
  "refundMethod"      TEXT,
  "totalRefundMinor"  INTEGER NOT NULL DEFAULT 0,
  "refundedAt"        TIMESTAMP(3),
  "refundProviderRef" TEXT,
  "pickupAddress"     JSONB,
  "pickupSlotId"      TEXT,
  "collectedAt"       TIMESTAMP(3),
  "closedByUserId"    TEXT,
  "closedAt"          TIMESTAMP(3),
  "evidenceUrls"      JSONB NOT NULL DEFAULT '[]',
  "internalNotes"     TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomReturn_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EcomReturn_code_key" ON "EcomReturn"("code");
CREATE INDEX "EcomReturn_businessId_status_createdAt_idx"
  ON "EcomReturn"("businessId", "status", "createdAt");
CREATE INDEX "EcomReturn_orderId_idx" ON "EcomReturn"("orderId");
CREATE INDEX "EcomReturn_customerEmail_idx" ON "EcomReturn"("customerEmail");

ALTER TABLE "EcomReturn"
  ADD CONSTRAINT "EcomReturn_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EcomReturnItem" (
  "id"                TEXT NOT NULL,
  "returnId"          TEXT NOT NULL,
  "orderItemId"       TEXT,
  "productId"         TEXT,
  "productName"       TEXT NOT NULL,
  "productSlug"       TEXT,
  "quantity"          INTEGER NOT NULL,
  "unitPriceMinor"    INTEGER NOT NULL,
  "refundAmountMinor" INTEGER NOT NULL,
  "disposition"       "EcomReturnDisposition" NOT NULL DEFAULT 'PENDING',
  "reason"            "EcomReturnReason",
  "note"              TEXT,
  "adjustmentId"      TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomReturnItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EcomReturnItem_returnId_idx" ON "EcomReturnItem"("returnId");
CREATE INDEX "EcomReturnItem_productId_idx" ON "EcomReturnItem"("productId");

ALTER TABLE "EcomReturnItem"
  ADD CONSTRAINT "EcomReturnItem_returnId_fkey"
    FOREIGN KEY ("returnId") REFERENCES "EcomReturn"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EcomReturnEvent" (
  "id"          TEXT NOT NULL,
  "returnId"    TEXT NOT NULL,
  "kind"        TEXT NOT NULL,
  "fromStatus"  "EcomReturnStatus",
  "toStatus"    "EcomReturnStatus",
  "message"     TEXT,
  "actorUserId" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EcomReturnEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EcomReturnEvent_returnId_createdAt_idx"
  ON "EcomReturnEvent"("returnId", "createdAt");

ALTER TABLE "EcomReturnEvent"
  ADD CONSTRAINT "EcomReturnEvent_returnId_fkey"
    FOREIGN KEY ("returnId") REFERENCES "EcomReturn"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── EcomReview ───────────────────────────────────────────────────────────

CREATE TABLE "EcomReview" (
  "id"                    TEXT NOT NULL,
  "businessId"            TEXT NOT NULL,
  "productId"             TEXT,
  "riderId"               TEXT,
  "orderId"               TEXT,
  "customerId"            TEXT,
  "customerName"          TEXT NOT NULL,
  "customerEmail"         TEXT,
  "rating"                INTEGER NOT NULL,
  "title"                 TEXT,
  "body"                  TEXT,
  "mediaUrls"             JSONB NOT NULL DEFAULT '[]',
  "status"                "EcomReviewStatus" NOT NULL DEFAULT 'PENDING',
  "flagReason"            TEXT,
  "merchantReply"         TEXT,
  "merchantReplyByUserId" TEXT,
  "merchantReplyAt"       TIMESTAMP(3),
  "helpfulCount"          INTEGER NOT NULL DEFAULT 0,
  "unhelpfulCount"        INTEGER NOT NULL DEFAULT 0,
  "verifiedBuyer"         BOOLEAN NOT NULL DEFAULT false,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomReview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EcomReview_businessId_productId_status_createdAt_idx"
  ON "EcomReview"("businessId", "productId", "status", "createdAt");
CREATE INDEX "EcomReview_businessId_riderId_status_createdAt_idx"
  ON "EcomReview"("businessId", "riderId", "status", "createdAt");
CREATE INDEX "EcomReview_businessId_status_createdAt_idx"
  ON "EcomReview"("businessId", "status", "createdAt");

ALTER TABLE "EcomReview"
  ADD CONSTRAINT "EcomReview_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── EcomBanner ───────────────────────────────────────────────────────────

CREATE TABLE "EcomBanner" (
  "id"              TEXT NOT NULL,
  "businessId"      TEXT NOT NULL,
  "placement"       "EcomBannerPlacement" NOT NULL,
  "sortOrder"       INTEGER NOT NULL DEFAULT 0,
  "locationId"      TEXT,
  "audience"        TEXT NOT NULL DEFAULT 'ALL',
  "startsAt"        TIMESTAMP(3),
  "endsAt"          TIMESTAMP(3),
  "scheduleJson"    JSONB,
  "desktopImageUrl" TEXT,
  "mobileImageUrl"  TEXT,
  "altText"         TEXT,
  "headline"        TEXT,
  "subheadline"     TEXT,
  "ctaLabel"        TEXT,
  "linkType"        TEXT NOT NULL DEFAULT 'NONE',
  "linkProductId"   TEXT,
  "linkCategoryId"  TEXT,
  "linkPageId"      TEXT,
  "linkUrl"         TEXT,
  "groupKey"        TEXT,
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "impressions"     INTEGER NOT NULL DEFAULT 0,
  "clicks"          INTEGER NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomBanner_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EcomBanner_businessId_placement_isActive_sortOrder_idx"
  ON "EcomBanner"("businessId", "placement", "isActive", "sortOrder");
CREATE INDEX "EcomBanner_businessId_locationId_idx"
  ON "EcomBanner"("businessId", "locationId");
CREATE INDEX "EcomBanner_businessId_startsAt_endsAt_idx"
  ON "EcomBanner"("businessId", "startsAt", "endsAt");

ALTER TABLE "EcomBanner"
  ADD CONSTRAINT "EcomBanner_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── EcomCmsBlock ─────────────────────────────────────────────────────────

CREATE TABLE "EcomCmsBlock" (
  "id"                TEXT NOT NULL,
  "businessId"        TEXT NOT NULL,
  "slotKey"           TEXT NOT NULL,
  "blockType"         "EcomCmsBlockType" NOT NULL,
  "sortOrder"         INTEGER NOT NULL DEFAULT 0,
  "payload"           JSONB NOT NULL DEFAULT '{}',
  "locationId"        TEXT,
  "audience"          TEXT NOT NULL DEFAULT 'ALL',
  "startsAt"          TIMESTAMP(3),
  "endsAt"            TIMESTAMP(3),
  "i18nOverrides"     JSONB,
  "status"            "EcomCmsBlockStatus" NOT NULL DEFAULT 'DRAFT',
  "publishedAt"       TIMESTAMP(3),
  "publishedByUserId" TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EcomCmsBlock_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EcomCmsBlock_businessId_slotKey_status_sortOrder_idx"
  ON "EcomCmsBlock"("businessId", "slotKey", "status", "sortOrder");
CREATE INDEX "EcomCmsBlock_businessId_status_idx"
  ON "EcomCmsBlock"("businessId", "status");

ALTER TABLE "EcomCmsBlock"
  ADD CONSTRAINT "EcomCmsBlock_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── EcomOrderEvent ───────────────────────────────────────────────────────

CREATE TABLE "EcomOrderEvent" (
  "id"          TEXT NOT NULL,
  "businessId"  TEXT NOT NULL,
  "orderId"     TEXT NOT NULL,
  "kind"        TEXT NOT NULL,
  "fromStatus"  TEXT,
  "toStatus"    TEXT,
  "message"     TEXT,
  "payload"     JSONB,
  "actorUserId" TEXT,
  "actorSource" TEXT NOT NULL DEFAULT 'ADMIN',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EcomOrderEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EcomOrderEvent_businessId_orderId_createdAt_idx"
  ON "EcomOrderEvent"("businessId", "orderId", "createdAt");
CREATE INDEX "EcomOrderEvent_orderId_createdAt_idx"
  ON "EcomOrderEvent"("orderId", "createdAt");

ALTER TABLE "EcomOrderEvent"
  ADD CONSTRAINT "EcomOrderEvent_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
