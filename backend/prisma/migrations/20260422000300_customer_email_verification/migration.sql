-- Customer email verification via OTP at signup.
-- Existing rows get emailVerified=true (grandfathered — they were created
-- under the old no-OTP flow and should not be locked out).

ALTER TABLE "Customer"
  ADD COLUMN "emailVerified"  BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN "emailOtp"       TEXT,
  ADD COLUMN "emailOtpExpiry" TIMESTAMP(3);

UPDATE "Customer" SET "emailVerified" = true;
