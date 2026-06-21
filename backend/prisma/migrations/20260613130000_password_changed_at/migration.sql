-- Session-revocation timestamp. Set on password reset/change; the auth
-- middleware rejects any JWT issued before this instant, so a password reset
-- invalidates stolen access/refresh tokens (previously valid for up to 7 days).
-- Nullable + no backfill → existing sessions are unaffected until a password
-- actually changes.
ALTER TABLE "User"     ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
ALTER TABLE "Customer" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
