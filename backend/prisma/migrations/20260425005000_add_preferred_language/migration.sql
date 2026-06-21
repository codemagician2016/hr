-- Per-user / per-customer preferred language (BCP-47 locale code).
-- NULL means "no explicit choice yet — follow cookie / browser preference".
ALTER TABLE "User" ADD COLUMN "preferredLanguage" TEXT;
ALTER TABLE "Customer" ADD COLUMN "preferredLanguage" TEXT;
