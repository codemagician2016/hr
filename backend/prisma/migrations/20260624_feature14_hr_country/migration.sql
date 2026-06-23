-- Feature 14 — Strict Single-Country Tenant Mode (India-first). Additive only.
-- Hand-authored to be idempotent so it applies cleanly to the isolated hr_test
-- schema (bootstrapped via `prisma db push`) as well as a clean migrate-deploy on
-- the box. Every ADD uses IF NOT EXISTS. NO existing column is touched; NO drops.
--
-- Adds four columns to Business — the AUTHORITATIVE tenant HR country/currency,
-- the lock-once timestamp, and the backfill quarantine flag. Every payroll / tax /
-- leave / statutory / letters / currency / UI decision routes off Business.hrCountry
-- via hr/tenant/countryContext.js. The data backfill (stamping hrCountry from each
-- tenant's entities) is a SEPARATE idempotent script: scripts/backfill-hr-country.js.

-- ── Business.hrCountry — the ONE country a tenant runs HR/payroll in (ISO-2) ─────
-- NULL = HR not yet set up. Set ONCE at POST /api/hr/setup/country, then immutable.
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "hrCountry" CHAR(2);

-- ── Business.hrCurrency — locked pay/display currency derived from hrCountry ─────
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "hrCurrency" CHAR(3);

-- ── Business.hrCountrySetAt — audit + lock guard (mirrors currencyChangedAt) ─────
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "hrCountrySetAt" TIMESTAMP(3);

-- ── Business.hrCountryAmbiguous — backfill quarantine (legacy mixed tenant) ──────
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "hrCountryAmbiguous" BOOLEAN NOT NULL DEFAULT false;
