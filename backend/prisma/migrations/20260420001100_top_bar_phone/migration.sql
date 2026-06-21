-- Top-bar phone: mirror the existing address override pattern so the owner
-- can show their contact phone in the thin strip above the navbar. Empty
-- override + visible=true falls back to Business.phone from Settings, so
-- the owner doesn't have to type it twice.

ALTER TABLE "BusinessContent"
  ADD COLUMN "businessPhoneOverride" TEXT,
  ADD COLUMN "showTopBarPhone" BOOLEAN NOT NULL DEFAULT true;
