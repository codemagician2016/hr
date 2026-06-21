-- Custom domain DIY pipeline status fields. Replaces Cloudflare for SaaS
-- with our own nginx + Let's Encrypt provisioning, so we need a state
-- machine to track DNS verification + cert issuance for each tenant's
-- custom domain.
--
-- State machine values: NONE | PENDING_DNS | PENDING_SSL | ACTIVE | FAILED

ALTER TABLE "Subscription" ADD COLUMN "customDomainStatus" TEXT DEFAULT 'NONE';
ALTER TABLE "Subscription" ADD COLUMN "customDomainStatusMessage" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "customDomainCheckedAt" TIMESTAMP(3);

-- Backfill: rows that already have a customDomain set start in PENDING_DNS
-- so the polling loop will re-check them. The Cloudflare-for-SaaS path
-- (customHostnameId) keeps working in parallel; controller chooses path.
UPDATE "Subscription"
   SET "customDomainStatus" = 'PENDING_DNS'
 WHERE "customDomain" IS NOT NULL
   AND "customDomainStatus" = 'NONE';
