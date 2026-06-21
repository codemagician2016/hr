-- P9 — Recipes that turn into a cart. Admin links existing products as
-- ingredients; storefront renders "Add all ingredients to cart".
CREATE TABLE "Recipe" (
  "id"           TEXT PRIMARY KEY,
  "businessId"   TEXT NOT NULL,
  "title"        TEXT NOT NULL,
  "slug"         TEXT NOT NULL,
  "description"  TEXT,
  "imageUrl"     TEXT,
  "servings"     INTEGER,
  "prepMinutes"  INTEGER,
  "cookMinutes"  INTEGER,
  "isPublished"  BOOLEAN NOT NULL DEFAULT FALSE,
  "sortOrder"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "Recipe_businessId_slug_key" ON "Recipe"("businessId","slug");
CREATE INDEX "Recipe_businessId_isPublished_sortOrder_idx" ON "Recipe"("businessId","isPublished","sortOrder");

CREATE TABLE "RecipeIngredient" (
  "id"        TEXT PRIMARY KEY,
  "recipeId"  TEXT NOT NULL REFERENCES "Recipe"("id") ON DELETE CASCADE,
  "productId" TEXT NOT NULL,
  "variantId" TEXT,
  "quantity"  INTEGER NOT NULL DEFAULT 1,
  "note"      TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "RecipeIngredient_recipeId_sortOrder_idx" ON "RecipeIngredient"("recipeId","sortOrder");
CREATE INDEX "RecipeIngredient_productId_idx" ON "RecipeIngredient"("productId");
