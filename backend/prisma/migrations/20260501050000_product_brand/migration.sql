-- Add optional brand label to Product (e.g. "Nestle", "Amul").
-- Shown in small caps above the product name on the storefront card.
ALTER TABLE "Product" ADD COLUMN "brand" TEXT;
