-- Auth hardening:
--  • otpAttempts — per-account failed-OTP counter (complements the per-IP
--    authLimiter; the OTP is invalidated once the cap is hit so a known email
--    can't be brute-forced across rotating IPs).
--  • hasPassword — distinguishes social-only customers (created with a random
--    password) from password-bearing ones, so Google-only customers aren't
--    forced to supply a "current password" they never set when changing the
--    password or deleting their account.
ALTER TABLE "User"     ADD COLUMN "otpAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Customer" ADD COLUMN "otpAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Customer" ADD COLUMN "hasPassword" BOOLEAN NOT NULL DEFAULT true;

-- Backfill: any customer with a linked social identity was created with a
-- random password → treat as social-only (no real password they can recall).
UPDATE "Customer" SET "hasPassword" = false
  WHERE id IN (SELECT DISTINCT "customerId" FROM "CustomerIdentity");
