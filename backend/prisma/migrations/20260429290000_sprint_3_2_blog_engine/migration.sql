-- Sprint 3.2 — Blog engine (STATIC Pro tier)

CREATE TABLE "BlogPost" (
  "id"              TEXT NOT NULL,
  "businessId"      TEXT NOT NULL,
  "slug"            TEXT NOT NULL,
  "title"           TEXT NOT NULL,
  "excerpt"         TEXT,
  "content"         TEXT NOT NULL,
  "coverImageUrl"   TEXT,
  "authorName"      TEXT,
  "tagsCsv"         TEXT,
  "isPublished"     BOOLEAN NOT NULL DEFAULT false,
  "publishedAt"     TIMESTAMP(3),
  "metaTitle"       TEXT,
  "metaDescription" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BlogPost_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BlogPost_businessId_slug_key" ON "BlogPost"("businessId", "slug");
CREATE INDEX "BlogPost_businessId_isPublished_publishedAt_idx" ON "BlogPost"("businessId", "isPublished", "publishedAt");
ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
