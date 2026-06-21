-- Sprint 3.2c — Blog categories. Additive only:
--   1. New BlogCategory table
--   2. New nullable BlogPost.categoryId column + FK + index
-- Existing posts get NULL on categoryId (uncategorised), no backfill
-- needed. Deleting a category SETs NULL on its posts so post history
-- survives a category cleanup.

CREATE TABLE "BlogCategory" (
    "id"         TEXT         NOT NULL,
    "businessId" TEXT         NOT NULL,
    "name"       TEXT         NOT NULL,
    "slug"       TEXT         NOT NULL,
    "sortOrder"  INTEGER      NOT NULL DEFAULT 0,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlogCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BlogCategory_businessId_slug_key"
    ON "BlogCategory" ("businessId", "slug");
CREATE INDEX "BlogCategory_businessId_sortOrder_idx"
    ON "BlogCategory" ("businessId", "sortOrder");

ALTER TABLE "BlogCategory" ADD CONSTRAINT "BlogCategory_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- BlogPost gets the optional FK. NULL means uncategorised; deleting
-- the category SETs NULL so the post survives.
ALTER TABLE "BlogPost" ADD COLUMN "categoryId" TEXT;

CREATE INDEX "BlogPost_categoryId_isPublished_publishedAt_idx"
    ON "BlogPost" ("categoryId", "isPublished", "publishedAt");

ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "BlogCategory"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
