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
// Feature 15 §8 — the SP→Emp→Entity country chain is hoisted to one shared helper
// (it is needed by the tax-projection assembler too). meTax imports it instead of
// re-implementing; behaviour is unchanged.
const { resolveStatutoryCountry } = require('../lib/resolveStatutoryCountry');

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

// Resolve the employee's statutory country (hoisted to lib/resolveStatutoryCountry).
// Thin alias kept for call-site stability; behaviour unchanged (fail-closed).
const resolveCountry = (businessId, emp) => resolveStatutoryCountry(businessId, emp);

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
          // Feature 15 — the additional declared OLD-regime inputs (prefill).
          sec80d: sp && sp.sec80DDeclared != null ? toNum(sp.sec80DDeclared) : 0,
          sec80ccd1b: sp && sp.sec80CCD1BDeclared != null ? toNum(sp.sec80CCD1BDeclared) : 0,
          sec80tta: sp && sp.sec80TTADeclared != null ? toNum(sp.sec80TTADeclared) : 0,
          sec24b: sp && sp.sec24BHomeLoanInterest != null ? toNum(sp.sec24BHomeLoanInterest) : 0,
          hra: sp && sp.hraExemptionClaimed ? null : 0, // amount not stored; flag only
        },
        hraExemptionClaimed: !!(sp && sp.hraExemptionClaimed),
        hraAnnualRentPaid: sp && sp.hraAnnualRentPaid != null ? toNum(sp.hraAnnualRentPaid) : 0,
        hraMetroCity: !!(sp && sp.hraMetroCity),
        previousEmployer: {
          taxableIncome: sp && sp.prevEmployerTaxableIncome != null ? toNum(sp.prevEmployerTaxableIncome) : 0,
          tdsDeducted: sp && sp.prevEmployerTdsDeducted != null ? toNum(sp.prevEmployerTdsDeducted) : 0,
          fy: sp && sp.prevEmployerFY ? sp.prevEmployerFY : null,
        },
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
      const isOld = regime === 'OLD';
      const sec80c = isOld ? Math.max(0, toNum(inv.sec80c)) : 0;
      update.section80CDeclared = sec80c;

      // Feature 15 — the additional OLD-regime declared inputs. Under NEW every
      // exemption/deduction is structurally zeroed (a stray declared 80C can't
      // leak a NEW-regime deduction — the projection engine also skips them).
      update.sec80DDeclared = isOld ? Math.max(0, toNum(inv.sec80d)) : 0;
      update.sec80CCD1BDeclared = isOld ? Math.max(0, toNum(inv.sec80ccd1b)) : 0;
      update.sec80TTADeclared = isOld ? Math.max(0, toNum(inv.sec80tta)) : 0;
      update.sec24BHomeLoanInterest = isOld ? Math.max(0, toNum(inv.sec24b)) : 0;
      const rentPaid = isOld ? Math.max(0, toNum(body.hraAnnualRentPaid)) : 0;
      update.hraAnnualRentPaid = rentPaid;
      update.hraMetroCity = isOld && !!body.hraMetroCity;
      // HRA is claimed when the employee declares rent OR an explicit HRA amount.
      update.hraExemptionClaimed = isOld && (rentPaid > 0 || toNum(inv.hra) > 0);

      // Previous-employer income/TDS (Form 12B). Counted by the assembler ONLY
      // when prevEmployerFY === the current FY (a stale prior-year decl can't
      // inflate this year's relief). FY format guard: "YYYY-YY".
      const pe = (body.previousEmployer && typeof body.previousEmployer === 'object') ? body.previousEmployer : {};
      const peFY = typeof pe.fy === 'string' && /^\d{4}-\d{2}$/.test(pe.fy.trim()) ? pe.fy.trim() : null;
      update.prevEmployerTaxableIncome = Math.max(0, toNum(pe.taxableIncome));
      update.prevEmployerTdsDeducted = Math.max(0, toNum(pe.tdsDeducted));
      update.prevEmployerFY = peFY;
      if (existing && (existing.prevEmployerFY || null) !== peFY) {
        elections.push({ field: 'prevEmployerFY', oldValue: existing.prevEmployerFY || null, newValue: peFY || 'null' });
      }
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
