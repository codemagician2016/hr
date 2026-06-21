-- Record that the user/customer accepted the Terms + Privacy Policy,
-- so we can prove consent under NZ Privacy Act / GDPR if asked.
-- AlterTable
ALTER TABLE "User"
  ADD COLUMN "termsAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "termsVersion"    TEXT;

ALTER TABLE "Customer"
  ADD COLUMN "termsAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "termsVersion"    TEXT;
