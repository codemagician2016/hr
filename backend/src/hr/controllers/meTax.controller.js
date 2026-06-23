'use strict';

/**
 * meTax.controller.js — Employee Self-Service (ESS) tax declaration, mounted at
 * /api/hr/me/tax-declaration. CUSTOMER session (req.customer); SELF_ONLY (the
 * employee is resolved from the session — no id is accepted from the client).
 *
 * WHY THIS EXISTS — the ESS tax page (audit #57) could collect a declaration but
 * had nowhere to persist it (POST 404'd), so every submission was lost. This
 * surface persists the declaration onto the employee's StatutoryProfile (the
 * authoritative statutory record the payroll engine reads) and prefills the page
 * from a GET, country-aware (IN regime + 80C/HRA; NZ tax code + KiwiSaver).
 *
 * Country is resolved server-side (StatutoryProfile → Employee → current entity)
 * and the submitted `country` is cross-checked against it — a wrong-country
 * payload (e.g. NZ fields for an IN employee) is rejected 422, never stored.
 *
 * Material changes (regime / tax code / KiwiSaver rate) append a
 * StatutoryElectionHistory row so the election trail is auditable.
 */

const prisma = require('../../core/lib/prisma');
const payrollService = require('../payroll/service');

const NZ_TAX_CODES = new Set(['M', 'ME', 'SB', 'S', 'SH', 'ST', 'SA', 'M SL', 'ME SL', 'SB SL', 'S SL', 'SH SL', 'ST SL', 'SA SL', 'WT', 'ND', 'STC', 'CAE', 'EDW', 'NSW']);
const KIWISAVER_RATES = new Set([0, 3, 4, 6, 8, 10]);

function normCc(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

// Resolve the active self employee (id + denormalized country) or null (lockout).
async function resolveActiveSelf(req) {
  const { businessId } = req.customer;
  const employeeId = await payrollService.resolveSelfEmployee(businessId, req.customer);
  if (!employeeId) return null;
  const emp = await prisma.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true, countryCode: true, isActive: true },
  });
  if (!emp || emp.isActive === false) return null;
  return emp;
}

// Resolve the employee's statutory country: StatutoryProfile → Employee → current
// entity. Returns 'IN' | 'NZ' | null (fail-closed — never assume a market).
async function resolveCountry(businessId, emp) {
  const sp = await prisma.statutoryProfile.findFirst({
    where: { businessId, employeeId: emp.id },
    select: { countryCode: true },
  });
  let cc = sp && normCc(sp.countryCode);
  if (!cc) cc = normCc(emp.countryCode);
  if (!cc) {
    const rec = await prisma.employmentRecord.findFirst({
      where: { businessId, employeeId: emp.id, isCurrent: true },
      select: { entity: { select: { countryCode: true } } },
    });
    cc = rec && rec.entity ? normCc(rec.entity.countryCode) : null;
  }
  return cc;
}

const noEmployee = (res) => res.status(404).json({ message: 'No active employee record for this account' });

// Decimal|string|number → JS number (for math/round only; original stored verbatim).
function toNum(v) {
  if (v == null) return 0;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── GET /me/tax-declaration — country + the saved declaration (for prefill) ───
async function getDeclaration(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const countryCode = await resolveCountry(businessId, emp);
    const sp = await prisma.statutoryProfile.findFirst({ where: { businessId, employeeId: emp.id } });

    let declaration = null;
    if (countryCode === 'IN') {
      declaration = {
        country: 'IN',
        regime: sp && sp.taxRegime ? sp.taxRegime : 'NEW',
        investments: {
          sec80c: sp && sp.section80CDeclared != null ? toNum(sp.section80CDeclared) : 0,
          hra: sp && sp.hraExemptionClaimed ? null : 0, // amount not stored; flag only
        },
        hraExemptionClaimed: !!(sp && sp.hraExemptionClaimed),
      };
    } else if (countryCode === 'NZ') {
      declaration = {
        country: 'NZ',
        taxCode: sp && sp.taxCode ? sp.taxCode : null,
        // Stored as a 0–1 decimal; surface as a whole-percent for the page.
        kiwiSaverRate: sp && sp.kiwiSaverEmployeeRate != null
          ? Math.round(toNum(sp.kiwiSaverEmployeeRate) * 100)
          : null,
        studentLoan: !!(sp && sp.studentLoan),
      };
    }

    res.json({ employeeId: emp.id, countryCode: countryCode || null, declaration });
  } catch (e) { next(e); }
}

// ── POST/PUT /me/tax-declaration — persist the declaration onto StatutoryProfile.
// Body (built by the ESS page):
//   IN: { country:'IN', regime:'NEW'|'OLD', investments:{ sec80c, sec80d, hra, ... } }
//   NZ: { country:'NZ', taxCode, kiwiSaverRate:Number }
async function saveDeclaration(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const countryCode = await resolveCountry(businessId, emp);
    if (!countryCode) {
      return res.status(422).json({ message: 'Your tax jurisdiction is not set up yet. Please contact HR.' });
    }
    const body = req.body || {};
    // Reject a wrong-country payload — never store NZ fields on an IN employee.
    if (body.country && normCc(body.country) && normCc(body.country) !== countryCode) {
      return res.status(422).json({ message: `This declaration is for ${countryCode}, not ${normCc(body.country)}.` });
    }

    // Build the update + record material elections for the audit history.
    const update = {};
    const elections = []; // { field, oldValue, newValue }
    const existing = await prisma.statutoryProfile.findFirst({ where: { businessId, employeeId: emp.id } });

    if (countryCode === 'IN') {
      const regime = String(body.regime || '').toUpperCase();
      if (regime !== 'NEW' && regime !== 'OLD') {
        return res.status(422).json({ message: 'regime must be NEW or OLD' });
      }
      update.taxRegime = regime;
      if (existing && existing.taxRegime !== regime) {
        elections.push({ field: 'taxRegime', oldValue: existing.taxRegime || null, newValue: regime });
      }
      const inv = (body.investments && typeof body.investments === 'object') ? body.investments : {};
      // 80C is the headline old-regime declaration; deductions don't apply under NEW.
      const sec80c = regime === 'OLD' ? Math.max(0, toNum(inv.sec80c)) : 0;
      update.section80CDeclared = sec80c;
      update.hraExemptionClaimed = regime === 'OLD' && toNum(inv.hra) > 0;
    } else if (countryCode === 'NZ') {
      const taxCode = String(body.taxCode || '').trim().toUpperCase();
      if (!NZ_TAX_CODES.has(taxCode)) {
        return res.status(422).json({ message: 'Enter a valid IRD tax code (e.g. M, ME, S SL).' });
      }
      const rate = body.kiwiSaverRate == null || body.kiwiSaverRate === '' ? 0 : Number(body.kiwiSaverRate);
      if (!KIWISAVER_RATES.has(rate)) {
        return res.status(422).json({ message: 'KiwiSaver rate must be 0, 3, 4, 6, 8 or 10%.' });
      }
      update.taxCode = taxCode;
      update.studentLoan = / SL$/.test(taxCode);
      // Store the contribution rate as a 0–1 decimal (schema: Decimal(5,4)).
      update.kiwiSaverEmployeeRate = rate / 100;
      update.kiwiSaverStatus = rate === 0 ? 'OPTED_OUT' : 'ACTIVE';
      if (existing) {
        if (existing.taxCode !== taxCode) elections.push({ field: 'taxCode', oldValue: existing.taxCode || null, newValue: taxCode });
        const prevRate = existing.kiwiSaverEmployeeRate != null ? Math.round(toNum(existing.kiwiSaverEmployeeRate) * 100) : null;
        if (prevRate !== rate) elections.push({ field: 'kiwiSaverEmployeeRate', oldValue: prevRate == null ? null : String(prevRate), newValue: String(rate) });
      }
    }

    const saved = await prisma.$transaction(async (tx) => {
      const profile = await tx.statutoryProfile.upsert({
        where: { employeeId: emp.id },
        update: { ...update, version: { increment: 1 } },
        create: { businessId, employeeId: emp.id, countryCode, ...update },
      });
      // Append election history rows (audit trail), best-effort within the tx.
      const today = new Date();
      for (const el of elections) {
        await tx.statutoryElectionHistory.create({
          data: {
            businessId,
            statutoryProfileId: profile.id,
            field: el.field,
            oldValue: el.oldValue,
            newValue: el.newValue,
            effectiveFrom: today,
            changedBy: req.customer.id,
          },
        });
      }
      return profile;
    });

    res.json({ ok: true, employeeId: emp.id, countryCode, saved: { id: saved.id, version: saved.version } });
  } catch (e) { next(e); }
}

module.exports = { getDeclaration, saveDeclaration };
