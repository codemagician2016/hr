-- Business.timezone — IANA zone identifier (e.g. "Pacific/Auckland").
-- Source of truth for: "is this slot already past now?", rendering staff
-- schedules, and converting slot times into the customer's local time on
-- the booking page. Backfilled to Pacific/Auckland for existing rows per
-- the 2026-04-20 owner request; new rows derive a default from the
-- selected country (single-TZ countries auto-populate; multi-TZ countries
-- expose a dropdown in the UI).

ALTER TABLE "Business" ADD COLUMN "timezone" TEXT;

UPDATE "Business" SET "timezone" = 'Pacific/Auckland' WHERE "timezone" IS NULL;
