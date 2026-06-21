-- Locations section (Multi-branch directory) — visibility + heading copy + nav label.
-- Branches themselves live in BusinessLocation; these columns only control the
-- storefront section. Additive + non-destructive (section off by default).
ALTER TABLE "BusinessContent" ADD COLUMN "showLocations" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BusinessContent" ADD COLUMN "locationsEyebrow" TEXT;
ALTER TABLE "BusinessContent" ADD COLUMN "locationsTitle" TEXT;
ALTER TABLE "BusinessContent" ADD COLUMN "locationsIntro" TEXT;
ALTER TABLE "BusinessContent" ADD COLUMN "navLocationsLabel" TEXT;
