-- Business.email — contact email shown on the public site and used when
-- customers click the "Email us" link in the top bar / footer. Compulsory
-- at setup time per 2026-04-20 product decision; kept nullable so existing
-- rows created before this rule aren't blocked — those owners will be asked
-- to fill it in from Admin → Settings (launch checklist blocks go-live
-- until they do).

ALTER TABLE "Business" ADD COLUMN "email" TEXT;
