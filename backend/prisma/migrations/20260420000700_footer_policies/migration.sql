-- Footer policies: business-editable policy documents (Privacy Policy, Terms,
-- Refund Policy, etc.) shown as clickable footer links. Stored as a JSON
-- string array: [{ name: string, details: string }]. Null / empty means no
-- policy links are shown.
-- AlterTable
ALTER TABLE "BusinessContent"
  ADD COLUMN "policies" TEXT;
