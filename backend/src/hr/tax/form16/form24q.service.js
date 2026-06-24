'use strict';

/**
 * form24q.service.js — Feature 24 Form-24Q export. The thin, DB-touching builder
 * that assembles the per-quarter pay-run aggregate the EXISTING pure
 * filing/india.js `generate24Q(payRun)` consumes, then calls it UNCHANGED. For Q4
 * it additionally assembles Annexure-II (the annual salary-detail + total-tax per
 * employee) sourced from the SAME Form16Certificate.partBJson (fallback: on-the-fly
 * buildPartB) so 24Q-Q4 and Form-16 Part B are one source of truth and can never
 * disagree. NO fork of the FVU generator — Annexure-II is an ADDITIVE meta field.
 *
 *   build24QAggregate({ businessId, entityId, financialYear, quarter, db }) → payRun input
 *   build24QAnnexureII({ businessId, entityId, financialYear, db })         → Annexure-II rows
 *   export24Q({ businessId, actorId, entityId, financialYear, quarter, persist })
 */

const prisma = require('../../../core/lib/prisma');
const { writeAudit } = require('../../../core/lib/audit');
const { assertCountry } = require('../../tenant/countryContext');
const filing = require('../../payroll/filing/india');
const assembler = require('./form16Assembler');

class Form24QError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.reason = code;
  }
}

function rupeesToMinor(v) {
  if (v == null) return 0;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

// FY quarter → its three taxPeriod months (Apr–Mar FY).
function quarterMonths(quarter, startYear) {
  return assembler._internals.quarterTaxPeriods(quarter, startYear);
}

// ── build24QAggregate — the generate24Q input contract ───────────────────────
/**
 * Assembles { entity, lines[], quarter, financialYear } from this quarter's
 * published payslip TDS + the entity's challan detail. Per-deductee line:
 * { employee:{pan,name,code}, taxableMinor, tdsMinor } — read from the SAME
 * Payslip.snapshotJson reader Part A uses.
 */
async function build24QAggregate({ businessId, entityId, financialYear, quarter, db = prisma }) {
  if (!['Q1', 'Q2', 'Q3', 'Q4'].includes(quarter)) throw new Form24QError('BAD_QUARTER', 'quarter must be Q1..Q4', 422);
  const { startYear } = assembler._internals.fyBounds(financialYear);
  const months = quarterMonths(quarter, startYear);

  const entity = await db.entity.findFirst({ where: { id: entityId, businessId } });
  if (!entity) throw new Form24QError('ENTITY_NOT_FOUND', 'Entity not found', 404);

  // Period window for this quarter (first day of month 1 → last day of month 3).
  const firstMonth = months[0];
  const lastMonth = months[months.length - 1];
  const periodStart = new Date(`${firstMonth}-01`);
  const [ly, lm] = lastMonth.split('-').map(Number);
  const periodEnd = new Date(Date.UTC(ly, lm, 0)); // last day of last month

  const payslips = await db.payslip.findMany({
    where: {
      businessId,
      deletedAt: null,
      status: { in: ['PUBLISHED', 'VIEWED'] },
      periodEnd: { gte: periodStart, lte: periodEnd },
      payRun: { entityId },
    },
    select: {
      employeeId: true, snapshotJson: true,
      employee: { select: { code: true, firstName: true, middleName: true, lastName: true, statutoryProfile: { select: { pan: true } } } },
    },
  });

  // Aggregate per employee across the quarter.
  const byEmp = new Map();
  for (const ps of payslips) {
    const snap = ps.snapshotJson || {};
    let tdsMinor = 0;
    let taxableMinor = 0;
    for (const d of (snap.employeeDeductions || [])) if (d && d.code === 'TDS') tdsMinor += rupeesToMinor(d.amount);
    for (const e of (snap.earnings || [])) taxableMinor += rupeesToMinor(e.amount);
    const emp = ps.employee || {};
    const cur = byEmp.get(ps.employeeId) || {
      employee: {
        pan: (emp.statutoryProfile && emp.statutoryProfile.pan) || null,
        name: [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(' ') || emp.code,
        code: emp.code || null,
      },
      taxableMinor: 0,
      tdsMinor: 0,
    };
    cur.taxableMinor += taxableMinor;
    cur.tdsMinor += tdsMinor;
    byEmp.set(ps.employeeId, cur);
  }
  const lines = [...byEmp.values()];

  // Challan deposit detail for the quarter (single aggregate challan, TRACES-style).
  const challan = await db.statutoryRemittance.findFirst({
    where: { businessId, entityId, kind: { in: ['IN_TDS', 'IN_FORM24Q'] }, taxPeriod: { in: months }, status: { in: ['PAID', 'FILED'] } },
    select: { challanRef: true, paidDate: true, filedDate: true },
    orderBy: { paidDate: 'desc' },
  });

  // The pure generate24Q input contract.
  return {
    quarter,
    financialYear,
    entity: {
      tan: entity.tan || '',
      name: entity.legalName || entity.tradeName || '',
      challanBsrCode: challan && challan.challanRef ? String(challan.challanRef).slice(0, 7) : '',
      challanSerial: challan && challan.challanRef ? challan.challanRef : '',
      challanDate: challan ? (challan.paidDate || challan.filedDate || '') : '',
    },
    lines,
  };
}

// ── build24QAnnexureII (Q4) — annual salary detail per employee (= Part B) ────
/**
 * For Q4 the 24Q must carry Annexure-II: each employee's full annual salary breakup
 * + Chapter-VIA + total tax. We source it from the SAME Form16Certificate.partBJson
 * (if the FY's Form-16 batch is COMPUTED/APPROVED/ISSUED) so 24Q-Q4 and Form-16 Part
 * B are one source of truth; else we fall back to computing Part B on the fly via
 * the SAME assembler (the numbers are identical either way) so 24Q never blocks on
 * Form-16 issuance.
 */
async function build24QAnnexureII({ businessId, entityId, financialYear, db = prisma }) {
  const { fyStartIso, fyEndIso } = assembler._internals.fyBounds(financialYear);

  // Prefer the frozen Form-16 certificates for this entity + FY.
  const batch = await db.form16Batch.findFirst({
    where: { businessId, entityId, financialYear, deletedAt: null },
    select: { id: true },
  });
  const certs = batch
    ? await db.form16Certificate.findMany({
        where: { businessId, batchId: batch.id },
        include: { employee: { select: { code: true, firstName: true, middleName: true, lastName: true, statutoryProfile: { select: { pan: true } } } } },
      })
    : [];

  const rows = [];
  const seen = new Set();
  for (const c of certs) {
    const B = c.partBJson || {};
    const emp = c.employee || {};
    seen.add(c.employeeId);
    rows.push(annexureRow({
      pan: (emp.statutoryProfile && emp.statutoryProfile.pan) || null,
      name: [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(' ') || emp.code,
      code: emp.code,
    }, B));
  }

  // ALWAYS include EVERY salaried employee for the FY (Finding 3). 24Q Annexure-II
  // is the statutory annual deductee list and MUST carry every salaried employee for
  // the year — including NIL-TDS ones (who have payslips but, being below the TDS
  // threshold, get no Form-16 certificate). The `seen` set already records which
  // employees a cert covered, and the `if (seen.has(...)) continue` guard below makes
  // this idempotent, so we run the payslip-driven fallback unconditionally and append
  // any FY-payslip employee not already covered by a certificate. (The previous
  // `certs.length === 0` gate dropped all nil-TDS employees the moment ANY cert
  // existed → a defective FVU return that under-reports deductees.)
  const payslipEmps = await db.payslip.findMany({
    where: {
      businessId, deletedAt: null, status: { in: ['PUBLISHED', 'VIEWED'] },
      periodEnd: { gte: new Date(fyStartIso), lte: new Date(fyEndIso) },
      payRun: { entityId },
    },
    select: { employeeId: true, employee: { select: { code: true, firstName: true, middleName: true, lastName: true, statutoryProfile: { select: { pan: true } } } } },
    distinct: ['employeeId'],
  });
  for (const p of payslipEmps) {
    if (seen.has(p.employeeId)) continue;
    seen.add(p.employeeId);
    const tds = await assembler._internals.readFyPayslipTds({ businessId, employeeId: p.employeeId, fyStartIso, fyEndIso, db });
    const { partB } = await assembler.buildPartB({ businessId, employeeId: p.employeeId, financialYear, ptMinor: tds.ptMinor, db });
    const emp = p.employee || {};
    rows.push(annexureRow({
      pan: (emp.statutoryProfile && emp.statutoryProfile.pan) || null,
      name: [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(' ') || emp.code,
      code: emp.code,
    }, partB));
  }

  return rows;
}

// Map a Part-B JSON into the Annexure-II record set (paise → rupees-2dp strings).
function annexureRow(employee, B) {
  const g = B.grossSalary || {};
  const r2 = (minor) => (Math.round(Number(minor) || 0) / 100).toFixed(2);
  return {
    pan: employee.pan || 'PANNOTAVBL',
    name: employee.name || '',
    code: employee.code || '',
    grossSalary: r2(g.total),
    exemptAllowances_section10: r2(B.exemptAllowances_section10_total),
    // §16 deductions that ACTUALLY reduce the certified income = standard deduction
    // only (PT is disclosed separately as a memo and is not netted into the certified
    // total income — see buildPartB), so the row foots: grossSalary − exempt − §16 ==
    // incomeUnderHeadSalaries. PT is surfaced as its own memo field.
    deductions_section16: r2(B.standardDeduction_section16ia || 0),
    professionalTax_section16iii_memo: r2(B.professionalTax_section16iii || 0),
    incomeUnderHeadSalaries: r2(B.incomeUnderHeadSalaries),
    grossTotalIncome: r2(B.grossTotalIncome),
    chapterVIA_totalDeductible: r2(B.chapterVIA && B.chapterVIA.totalDeductible),
    totalIncome: r2(B.totalIncome),
    totalTaxPayable: r2(B.netTaxPayable),
    totalTdsDeducted: r2(B.tdsDeducted),
    regime: B.regime || 'NEW',
  };
}

// ── export24Q — build aggregate → generate24Q (+ Annexure-II for Q4) ─────────
async function export24Q({ businessId, actorId, entityId, financialYear, quarter, persist = false, db = prisma }) {
  const entity = await db.entity.findFirst({ where: { id: entityId, businessId } });
  if (!entity) throw new Form24QError('ENTITY_NOT_FOUND', 'Entity not found', 404);
  if (entity.countryCode) await assertCountry(businessId, entity.countryCode);
  if (entity.countryCode !== 'IN') throw new Form24QError('COUNTRY_NOT_SUPPORTED', 'Form 24Q applies to India only', 404);

  const payRun = await build24QAggregate({ businessId, entityId, financialYear, quarter, db });
  const out = filing.generate24Q(payRun); // PURE, unchanged.

  // Q4 carries Annexure-II (the annual breakup) — additive to the pure generator's
  // meta, no behaviour change to the FH/BH/CD/DD records.
  if (out.meta && out.meta.annexureII === true) {
    out.meta.annexureII = await build24QAnnexureII({ businessId, entityId, financialYear, db });
  }

  // Optional: persist the file to StatutoryRemittance(IN_FORM24Q).fileUrl (reuse,
  // no new model). Natural-keyed on (businessId, entityId, kind, taxPeriod, stateCode).
  let remittance = null;
  if (persist) {
    const taxPeriod = `${financialYear}-${quarter}`;
    const dataUrl = `data:text/plain;base64,${Buffer.from(out.content, 'utf8').toString('base64')}`;
    const { fyEndIso } = assembler._internals.fyBounds(financialYear);
    remittance = await db.statutoryRemittance.upsert({
      where: { businessId_entityId_kind_taxPeriod_stateCode: { businessId, entityId, kind: 'IN_FORM24Q', taxPeriod, stateCode: '' } },
      create: {
        businessId, entityId, kind: 'IN_FORM24Q', taxPeriod, stateCode: '',
        amount: out.meta.totals.tdsRupees, currencyCode: 'INR',
        dueDate: new Date(fyEndIso), fileUrl: dataUrl, status: 'PENDING',
      },
      update: { fileUrl: dataUrl, amount: out.meta.totals.tdsRupees },
    }).catch(async () => {
      // Some schemas index stateCode via a COALESCE expression rather than a plain
      // unique on ''. Fall back to find-then-update so persist never hard-fails.
      const existing = await db.statutoryRemittance.findFirst({ where: { businessId, entityId, kind: 'IN_FORM24Q', taxPeriod } });
      if (existing) return db.statutoryRemittance.update({ where: { id: existing.id }, data: { fileUrl: dataUrl, amount: out.meta.totals.tdsRupees } });
      return db.statutoryRemittance.create({
        data: { businessId, entityId, kind: 'IN_FORM24Q', taxPeriod, stateCode: null, amount: out.meta.totals.tdsRupees, currencyCode: 'INR', dueDate: new Date(fyEndIso), fileUrl: dataUrl, status: 'PENDING' },
      });
    });
  }

  await writeAudit({ businessId, actorId, action: 'form24q.export', entityType: 'Entity', entityId, meta: { financialYear, quarter, deducteeCount: out.meta.deducteeCount, persisted: !!persist } });

  return { fileName: out.fileName, contentType: out.contentType, content: out.content, meta: out.meta, remittanceId: remittance ? remittance.id : null };
}

module.exports = {
  Form24QError,
  build24QAggregate,
  build24QAnnexureII,
  export24Q,
};
