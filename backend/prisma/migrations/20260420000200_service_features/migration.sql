-- Per-service bullet features list + highlight flag, so the Services
-- section on the public site can render card-style (like the old pricing
-- tiers) with or without a picture.
-- AlterTable
ALTER TABLE "Service"
  ADD COLUMN "features"    TEXT,
  ADD COLUMN "highlighted" BOOLEAN NOT NULL DEFAULT false;
