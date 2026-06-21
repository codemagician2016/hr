-- Sprint 2.5 — WhatsApp ordering (ECOMMERCE Pro tier)
ALTER TABLE "Business"
  ADD COLUMN "whatsappOrderNumber"  TEXT,
  ADD COLUMN "whatsappOrdersEnabled" BOOLEAN NOT NULL DEFAULT false;
