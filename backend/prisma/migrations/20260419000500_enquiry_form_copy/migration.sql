-- Contact section → enquiry-form copy overrides
-- AlterTable
ALTER TABLE "BusinessContent"
  ADD COLUMN "enquiryFormTitle"   TEXT,
  ADD COLUMN "enquiryFormBody"    TEXT,
  ADD COLUMN "enquiryFormCta"     TEXT,
  ADD COLUMN "enquiryThanksTitle" TEXT,
  ADD COLUMN "enquiryThanksBody"  TEXT;
