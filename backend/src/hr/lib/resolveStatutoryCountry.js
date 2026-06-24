'use strict';

/**
 * resolveStatutoryCountry.js — Feature 15 §8 hoist. THE single helper that resolves
 * an employee's statutory country, fail-closed, the way meTax.controller did inline
 * (StatutoryProfile → Employee → current entity, then the tenant country as the
 * single source of truth). It was duplicated logic the tax-projection assembler now
 * needs in a second place; hoisted once so there is exactly one copy.
 *
 * Feature 14 — the tenant HR country is authoritative. The per-row chain is kept as a
 * TRIPWIRE: if a row carries a country it MUST equal the tenant country (else a bad
 * backfill / quarantined tenant → throw, never serve the wrong market). When no row
 * carries a country we fall through to the tenant country. Returns 'IN' | 'NZ' (the
 * registrable markets) — never a silent default.
 *
 * @param {string} businessId
 * @param {{ id: string, countryCode?: string }} emp  the resolved self/subject employee
 * @param {object} [db]  optional Prisma client/tx (defaults to the shared singleton)
 * @returns {Promise<string>} the resolved ISO-2 country code (uppercased)
 */

const prisma = require('../../core/lib/prisma');
const { tenantCountry, assertCountry } = require('../tenant/countryContext');

function normCc(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

async function resolveStatutoryCountry(businessId, emp, db = prisma) {
  const tCountry = await tenantCountry(businessId);
  const sp = await db.statutoryProfile.findFirst({
    where: { businessId, employeeId: emp.id },
    select: { countryCode: true },
  });
  let cc = sp && normCc(sp.countryCode);
  if (!cc) cc = normCc(emp.countryCode);
  if (!cc) {
    const rec = await db.employmentRecord.findFirst({
      where: { businessId, employeeId: emp.id, isCurrent: true },
      select: { entity: { select: { countryCode: true } } },
    });
    cc = rec && rec.entity ? normCc(rec.entity.countryCode) : null;
  }
  if (cc) {
    await assertCountry(businessId, cc); // tripwire — throws COUNTRY_MISMATCH on drift
    return cc;
  }
  return tCountry;
}

module.exports = { resolveStatutoryCountry, normCc };
