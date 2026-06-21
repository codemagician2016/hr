-- 3-level category support — Business.categoryMaxDepth controls how
-- deeply ProductCategory.parentId can chain. 1 = flat, 2 = current
-- default (parent + child), 3 = parent + child + sub-child. Higher
-- values reserved for future tiers. Backend enforces via
-- backend/src/core/lib/categoryDepth.js — schema is unchanged
-- structurally (parentId already supports any depth), this column
-- just records the per-tenant cap.

ALTER TABLE "Business"
  ADD COLUMN "categoryMaxDepth" INTEGER NOT NULL DEFAULT 2;
