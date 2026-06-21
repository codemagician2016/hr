-- Sprint 3.2b — Blog comments + likes + per-tenant settings.
-- Additive only: 4 new enums + 3 new tables + their indexes / FKs.
-- Existing BlogPost rows pick up their relations transparently.
-- BlogSettings is created lazily on first read by the controller (no
-- backfill in this migration).

-- ─── Enums ──────────────────────────────────────────────────────────────────
CREATE TYPE "BlogCommentStatus" AS ENUM ('PENDING', 'APPROVED', 'SPAM');
CREATE TYPE "BlogCommentAuthorType" AS ENUM ('GUEST', 'CUSTOMER');
CREATE TYPE "BlogModerationMode" AS ENUM ('NONE', 'PRE_MODERATE');
CREATE TYPE "BlogParticipantPolicy" AS ENUM ('NONE', 'GUEST_ONLY', 'REGISTERED_ONLY', 'BOTH');

-- ─── BlogComment ────────────────────────────────────────────────────────────
CREATE TABLE "BlogComment" (
    "id"          TEXT                    NOT NULL,
    "businessId"  TEXT                    NOT NULL,
    "postId"      TEXT                    NOT NULL,
    "parentId"    TEXT,
    "authorType"  "BlogCommentAuthorType" NOT NULL,
    "customerId"  TEXT,
    "authorName"  TEXT                    NOT NULL,
    "authorEmail" TEXT                    NOT NULL,
    "body"        TEXT                    NOT NULL,
    "status"      "BlogCommentStatus"     NOT NULL DEFAULT 'PENDING',
    "ipAddress"   TEXT,
    "userAgent"   TEXT,
    "createdAt"   TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3)            NOT NULL,

    CONSTRAINT "BlogComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BlogComment_postId_status_createdAt_idx"
    ON "BlogComment" ("postId", "status", "createdAt");
CREATE INDEX "BlogComment_businessId_status_createdAt_idx"
    ON "BlogComment" ("businessId", "status", "createdAt");
CREATE INDEX "BlogComment_parentId_idx"
    ON "BlogComment" ("parentId");

ALTER TABLE "BlogComment" ADD CONSTRAINT "BlogComment_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BlogComment" ADD CONSTRAINT "BlogComment_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "BlogPost"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BlogComment" ADD CONSTRAINT "BlogComment_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "BlogComment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BlogComment" ADD CONSTRAINT "BlogComment_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── BlogLike ───────────────────────────────────────────────────────────────
CREATE TABLE "BlogLike" (
    "id"         TEXT         NOT NULL,
    "businessId" TEXT         NOT NULL,
    "postId"     TEXT         NOT NULL,
    "customerId" TEXT,
    "sessionId"  TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlogLike_pkey" PRIMARY KEY ("id")
);

-- Unique constraints prevent the same actor from liking a post twice.
-- NULL values are treated as distinct in Postgres, so both constraints
-- coexist cleanly: a row uses customerId XOR sessionId, never both.
CREATE UNIQUE INDEX "BlogLike_postId_customerId_key"
    ON "BlogLike" ("postId", "customerId");
CREATE UNIQUE INDEX "BlogLike_postId_sessionId_key"
    ON "BlogLike" ("postId", "sessionId");
CREATE INDEX "BlogLike_businessId_createdAt_idx"
    ON "BlogLike" ("businessId", "createdAt");

ALTER TABLE "BlogLike" ADD CONSTRAINT "BlogLike_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BlogLike" ADD CONSTRAINT "BlogLike_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "BlogPost"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BlogLike" ADD CONSTRAINT "BlogLike_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── BlogSettings ───────────────────────────────────────────────────────────
CREATE TABLE "BlogSettings" (
    "id"                       TEXT                    NOT NULL,
    "businessId"               TEXT                    NOT NULL,
    "commentsEnabled"          BOOLEAN                 NOT NULL DEFAULT true,
    "likesEnabled"             BOOLEAN                 NOT NULL DEFAULT true,
    "commentPolicy"            "BlogParticipantPolicy" NOT NULL DEFAULT 'BOTH',
    "likePolicy"               "BlogParticipantPolicy" NOT NULL DEFAULT 'BOTH',
    "moderationMode"           "BlogModerationMode"    NOT NULL DEFAULT 'PRE_MODERATE',
    "notifyAdminOnNewComment"  BOOLEAN                 NOT NULL DEFAULT true,
    "guestRequiresEmail"       BOOLEAN                 NOT NULL DEFAULT true,
    "createdAt"                TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                TIMESTAMP(3)            NOT NULL,

    CONSTRAINT "BlogSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BlogSettings_businessId_key"
    ON "BlogSettings" ("businessId");

ALTER TABLE "BlogSettings" ADD CONSTRAINT "BlogSettings_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
