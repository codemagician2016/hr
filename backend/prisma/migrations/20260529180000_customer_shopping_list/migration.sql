-- P7 — Persistent shopping lists. One customer can keep multiple named
-- lists ("My list" seeded on first use); "add list to cart" silently
-- skips items that are no longer purchasable.
CREATE TABLE "CustomerShoppingList" (
  "id"         TEXT PRIMARY KEY,
  "businessId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "name"       TEXT NOT NULL DEFAULT 'My list',
  "isDefault"  BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL
);
CREATE INDEX "CustomerShoppingList_businessId_customerId_idx" ON "CustomerShoppingList"("businessId","customerId");

CREATE TABLE "ShoppingListItem" (
  "id"        TEXT PRIMARY KEY,
  "listId"    TEXT NOT NULL REFERENCES "CustomerShoppingList"("id") ON DELETE CASCADE,
  "productId" TEXT NOT NULL,
  "variantId" TEXT,
  "quantity"  INTEGER NOT NULL DEFAULT 1,
  "note"      TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ShoppingListItem_listId_productId_variantId_key" ON "ShoppingListItem"("listId","productId","variantId");
CREATE INDEX "ShoppingListItem_productId_idx" ON "ShoppingListItem"("productId");
