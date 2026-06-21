-- Multi-provider social identities (Google now; Apple / Microsoft / etc.
-- later). (businessId, email) on Customer stays the primary tenant identity
-- key; this table records provider linkages so any OIDC provider can attach
-- without further schema changes. Customer.googleId is kept and backfilled.

CREATE TABLE "CustomerIdentity" (
  "id"          TEXT NOT NULL,
  "businessId"  TEXT NOT NULL,
  "customerId"  TEXT NOT NULL,
  "provider"    TEXT NOT NULL,
  "subject"     TEXT NOT NULL,
  "email"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastLoginAt" TIMESTAMP(3),
  CONSTRAINT "CustomerIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerIdentity_businessId_provider_subject_key"
  ON "CustomerIdentity" ("businessId", "provider", "subject");
CREATE UNIQUE INDEX "CustomerIdentity_customerId_provider_key"
  ON "CustomerIdentity" ("customerId", "provider");
CREATE INDEX "CustomerIdentity_customerId_idx"
  ON "CustomerIdentity" ("customerId");
CREATE INDEX "CustomerIdentity_businessId_idx"
  ON "CustomerIdentity" ("businessId");

ALTER TABLE "CustomerIdentity"
  ADD CONSTRAINT "CustomerIdentity_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill existing Google links so no logged-in user regresses. The id is
-- derived deterministically from the customer id so this is idempotent and
-- needs no uuid extension. ON CONFLICT guards against any pre-existing dupes.
INSERT INTO "CustomerIdentity"
  ("id", "businessId", "customerId", "provider", "subject", "email", "createdAt")
SELECT
  'idn_google_' || c."id",
  c."businessId",
  c."id",
  'google',
  c."googleId",
  c."email",
  c."createdAt"
FROM "Customer" c
WHERE c."googleId" IS NOT NULL AND c."googleId" <> ''
ON CONFLICT DO NOTHING;
