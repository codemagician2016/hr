-- Add parent/child support to ProductCategory (one level of nesting)
ALTER TABLE "ProductCategory" ADD COLUMN "parentId" TEXT;

ALTER TABLE "ProductCategory"
  ADD CONSTRAINT "ProductCategory_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "ProductCategory"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ProductCategory_parentId_idx" ON "ProductCategory"("parentId");
