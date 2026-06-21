-- Shared SEO Center foundation. Web vertical uses it first; booking and
-- e-commerce can reuse the same tables by adding their own URL adapters.

CREATE TABLE IF NOT EXISTS "BusinessSeoSettings" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "siteTitle" TEXT,
  "siteDescription" TEXT,
  "defaultKeywords" TEXT,
  "canonicalDomain" TEXT,
  "defaultOgImageUrl" TEXT,
  "googleAnalyticsId" TEXT,
  "googleTagManagerId" TEXT,
  "googleSearchConsoleVerification" TEXT,
  "metaPixelId" TEXT,
  "bingVerification" TEXT,
  "allowIndexing" BOOLEAN NOT NULL DEFAULT true,
  "aiCrawlerPolicy" TEXT NOT NULL DEFAULT 'allow',
  "enableLlmsTxt" BOOLEAN NOT NULL DEFAULT true,
  "schemaType" TEXT,
  "socialSameAs" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BusinessSeoSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessSeoSettings_businessId_key"
ON "BusinessSeoSettings"("businessId");

ALTER TABLE "BusinessSeoSettings"
ADD CONSTRAINT "BusinessSeoSettings_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "SeoPageOverride" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "pageType" TEXT NOT NULL,
  "entityId" TEXT,
  "pageTitle" TEXT,
  "metaTitle" TEXT,
  "metaDescription" TEXT,
  "keywords" TEXT,
  "canonicalUrl" TEXT,
  "ogTitle" TEXT,
  "ogDescription" TEXT,
  "ogImageUrl" TEXT,
  "noIndex" BOOLEAN NOT NULL DEFAULT false,
  "includeInSitemap" BOOLEAN NOT NULL DEFAULT true,
  "sitemapPriority" DOUBLE PRECISION,
  "changeFrequency" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SeoPageOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SeoPageOverride_businessId_url_key"
ON "SeoPageOverride"("businessId", "url");

CREATE INDEX IF NOT EXISTS "SeoPageOverride_businessId_pageType_idx"
ON "SeoPageOverride"("businessId", "pageType");

ALTER TABLE "SeoPageOverride"
ADD CONSTRAINT "SeoPageOverride_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
