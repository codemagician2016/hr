-- DropForeignKey
ALTER TABLE "Waitlist" DROP CONSTRAINT "Waitlist_businessId_fkey";

-- DropForeignKey
ALTER TABLE "Waitlist" DROP CONSTRAINT "Waitlist_customerId_fkey";

-- DropForeignKey
ALTER TABLE "Waitlist" DROP CONSTRAINT "Waitlist_serviceId_fkey";

-- DropForeignKey
ALTER TABLE "Waitlist" DROP CONSTRAINT "Waitlist_staffId_fkey";

-- DropIndex
DROP INDEX "CartItem_cartId_productId_key";

-- DropIndex
DROP INDEX "PricingTier_vertical_isActive_sortOrder_idx";

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "announcementBarBgColor" TEXT NOT NULL DEFAULT '#146A39',
ADD COLUMN     "announcementBarEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "announcementBarText" TEXT,
ADD COLUMN     "announcementBarTextColor" TEXT NOT NULL DEFAULT '#ffffff',
ADD COLUMN     "wishlistEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "wishlistIconType" TEXT NOT NULL DEFAULT 'bookmark';

-- AlterTable
ALTER TABLE "CartItem" ADD COLUMN     "variantId" TEXT;

-- AlterTable
ALTER TABLE "EmailDelivery" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "InboxNotification" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "discountDisplayMode" TEXT NOT NULL DEFAULT 'PERCENTAGE';

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sku" TEXT,
    "priceMinor" INTEGER NOT NULL,
    "comparePriceMinor" INTEGER,
    "stockQty" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wishlist" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wishlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WishlistItem" (
    "id" TEXT NOT NULL,
    "wishlistId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WishlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductVariant_productId_sortOrder_idx" ON "ProductVariant"("productId", "sortOrder");

-- CreateIndex
CREATE INDEX "Wishlist_businessId_customerId_idx" ON "Wishlist"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "Wishlist_businessId_sessionId_idx" ON "Wishlist"("businessId", "sessionId");

-- CreateIndex
CREATE INDEX "WishlistItem_wishlistId_productId_idx" ON "WishlistItem"("wishlistId", "productId");

-- CreateIndex
CREATE INDEX "WishlistItem_variantId_idx" ON "WishlistItem"("variantId");

-- CreateIndex
CREATE INDEX "CartItem_cartId_productId_variantId_idx" ON "CartItem"("cartId", "productId", "variantId");

-- CreateIndex
CREATE INDEX "CartItem_variantId_idx" ON "CartItem"("variantId");

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wishlist" ADD CONSTRAINT "Wishlist_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wishlist" ADD CONSTRAINT "Wishlist_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_wishlistId_fkey" FOREIGN KEY ("wishlistId") REFERENCES "Wishlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitlist" ADD CONSTRAINT "Waitlist_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitlist" ADD CONSTRAINT "Waitlist_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitlist" ADD CONSTRAINT "Waitlist_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitlist" ADD CONSTRAINT "Waitlist_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "AutomationEnrollment_unique_per_trigger" RENAME TO "AutomationEnrollment_businessId_campaignId_customerId_trigg_key";

-- RenameIndex
ALTER INDEX "CustomerMarketingOptOut_businessId_recipientEmail_campaignKey_k" RENAME TO "CustomerMarketingOptOut_businessId_recipientEmail_campaignK_key";
