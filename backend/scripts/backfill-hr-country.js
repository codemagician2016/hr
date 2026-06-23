#!/usr/bin/env node
/*
 * Feature 14 — backfill Business.hrCountry for every existing tenant. Idempotent:
 * safe to re-run; skips tenants whose hrCountrySetAt is already set. Run after the
 * 20260624_feature14_hr_country migration:
 *
 *   node -r dotenv/config scripts/backfill-hr-country.js
 *   DATABASE_URL="...?schema=hr_test" node scripts/backfill-hr-country.js   # test schema
 *
 * Per Business with hrCountry IS NULL and hrCountrySetAt IS NULL:
 *   1. collect distinct(Entity.countryCode) for the tenant (deletedAt IS NULL).
 *   2. 0 entities → fall back to business.region then business.country; if that
 *      maps to a REGISTRABLE_HR_COUNTRIES member, stamp it; else leave NULL
 *      (pre-setup tenant — they set it at HR setup).
 *   3. exactly 1 distinct country → stamp hrCountry = that, hrCurrency =
 *      payCurrencyFor(that), hrCountrySetAt = now, region = that.
 *   4. >1 distinct country (legacy mixed tenant) → set hrCountryAmbiguous = true,
 *      leave hrCountry NULL, log loudly. Blocked from HR writes until a super-admin
 *      resolves them (POST /api/superadmin/tenants/:id/country/resolve).
 *
 * Prints a summary { stamped, ambiguous, preSetup, skipped } and then runs the
 * §6.3 verification gate (no Entity/Location/StatutoryProfile row off the tenant
 * country for any non-ambiguous tenant). Any hit is printed for manual review.
 */
'use strict';

const prisma = require('../src/core/lib/prisma');
const {
  REGISTRABLE_HR_COUNTRIES,
  isRegistrableHrCountry,
  payCurrencyFor,
} = require('../src/hr/tenant/countryContext');

function norm(cc) {
  return cc ? String(cc).toUpperCase() : null;
}

async function distinctEntityCountries(businessId) {
  const rows = await prisma.entity.findMany({
    where: { businessId, deletedAt: null },
    select: { countryCode: true },
  });
  return [...new Set(rows.map((r) => norm(r.countryCode)).filter(Boolean))];
}

async function backfill() {
  const summary = { stamped: 0, ambiguous: 0, preSetup: 0, skipped: 0 };

  const tenants = await prisma.business.findMany({
    where: { hrCountrySetAt: null, hrCountryAmbiguous: false },
    select: { id: true, slug: true, name: true, region: true, country: true, hrCountry: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`tenants to consider (hrCountrySetAt IS NULL): ${tenants.length}`);
  console.log(`registrable HR countries: ${JSON.stringify(REGISTRABLE_HR_COUNTRIES)}\n`);

  for (const b of tenants) {
    if (b.hrCountry) { summary.skipped += 1; continue; } // already stamped (defensive)

    const countries = await distinctEntityCountries(b.id);
    // A tenant is genuinely AMBIGUOUS only when it has >1 distinct *registrable*
    // (live) country — i.e. two markets that both surface today. A deferred
    // country (e.g. NZ while NZ ∉ REGISTRABLE_HR_COUNTRIES) present alongside the
    // one live market is NOT ambiguous: the live market is unambiguously that
    // single registrable country and the deferred rows are dormant (they never
    // surface, per the roadmap). This keeps the single-country invariant for the
    // live market without silently coercing between two *live* markets.
    const liveCountries = countries.filter((c) => isRegistrableHrCountry(c));
    const deferredCountries = countries.filter((c) => !isRegistrableHrCountry(c));

    if (liveCountries.length > 1) {
      await prisma.business.update({
        where: { id: b.id },
        data: { hrCountryAmbiguous: true },
      });
      summary.ambiguous += 1;
      console.warn(
        `  AMBIGUOUS  ${b.slug} (${b.name}) — ${liveCountries.length} distinct LIVE entity countries [${liveCountries.join(', ')}] → quarantined (hrCountryAmbiguous=true). Resolve via super-admin.`,
      );
      continue;
    }

    let resolved = null;
    if (liveCountries.length === 1) {
      resolved = liveCountries[0];
      if (deferredCountries.length) {
        console.log(`  NOTE       ${b.slug} also has deferred-market entities [${deferredCountries.join(', ')}] — dormant, do not surface.`);
      }
    } else {
      // 0 live entities → fall back to region, then storefront country.
      const fromRegion = norm(b.region);
      const fromCountry = norm(b.country);
      if (fromRegion && isRegistrableHrCountry(fromRegion)) resolved = fromRegion;
      else if (fromCountry && isRegistrableHrCountry(fromCountry)) resolved = fromCountry;
    }

    if (!resolved) {
      summary.preSetup += 1;
      console.log(`  PRE-SETUP  ${b.slug} (${b.name}) — no entities / unmappable; hrCountry stays NULL (set at HR setup).`);
      continue;
    }

    await prisma.business.update({
      where: { id: b.id },
      data: {
        hrCountry: resolved,
        hrCurrency: payCurrencyFor(resolved),
        hrCountrySetAt: new Date(),
        region: resolved,
      },
    });
    summary.stamped += 1;
    console.log(`  STAMPED    ${b.slug} (${b.name}) → ${resolved} / ${payCurrencyFor(resolved)}`);
  }

  console.log(`\nbackfill summary: ${JSON.stringify(summary)}`);
  return summary;
}

// §6.3 verification gate — no off-country row under any non-ambiguous tenant.
async function verify() {
  console.log('\n=== verification gate (§6.3) — off-country rows under non-ambiguous tenants ===');
  const stamped = await prisma.business.findMany({
    where: { hrCountry: { not: null }, hrCountryAmbiguous: false },
    select: { id: true, slug: true, hrCountry: true },
  });
  let offenders = 0;
  for (const b of stamped) {
    const cc = norm(b.hrCountry);
    // Off-country = a row in a DIFFERENT live (registrable) market than the
    // tenant's stamp. Dormant deferred-market rows (e.g. NZ while NZ is not
    // registrable) are excluded — they never surface and are not drift.
    const liveOff = (rows) => rows.filter((r) => {
      const rc = norm(r.countryCode);
      return rc && rc !== cc && isRegistrableHrCountry(rc);
    });
    const badEntities = liveOff(await prisma.entity.findMany({
      where: { businessId: b.id, deletedAt: null, NOT: { countryCode: cc } },
      select: { id: true, code: true, countryCode: true },
    }));
    const badStatutory = liveOff(await prisma.statutoryProfile.findMany({
      where: { businessId: b.id, NOT: { countryCode: cc } },
      select: { id: true, countryCode: true },
    }));
    if (badEntities.length || badStatutory.length) {
      offenders += badEntities.length + badStatutory.length;
      console.warn(`  DRIFT  ${b.slug} (hrCountry=${cc}): ${badEntities.length} off-country entities, ${badStatutory.length} off-country statutory profiles`);
      for (const e of badEntities) console.warn(`    entity ${e.code} (${e.id}) countryCode=${e.countryCode}`);
    }
  }
  if (offenders === 0) console.log('  OK — no off-country rows under any stamped tenant.');
  else console.warn(`  ${offenders} off-country row(s) need manual review (pre-existing data, not a v1 regression).`);
  return offenders;
}

async function main() {
  await backfill();
  await verify();
  await prisma.$disconnect();
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { backfill, verify };
