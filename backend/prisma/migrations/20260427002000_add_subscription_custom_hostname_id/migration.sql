-- Subscription.customHostnameId — Cloudflare for SaaS Custom Hostname
-- object ID. Required so we can poll status + delete on disconnect
-- without paginating the full list of custom hostnames in the zone.

ALTER TABLE "Subscription" ADD COLUMN "customHostnameId" TEXT;
