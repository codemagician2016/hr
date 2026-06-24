'use strict';

/**
 * arrears.service.js — Auto-Arrear orchestrator (Feature 27). The DB-touching, thin
 * layer over the PURE payroll/arrears.js core, mirroring bonus.service.js 1:1:
 *   detect retro revisions → create a cycle → RE-RUN the pure engine for each elapsed
 *   month at the NEW comp using THAT month's FROZEN attendance → diff vs the frozen
 *   paid Payslip → aggregate the arrear + PF/ESI (per source month) + §89(1) relief →
 *   SoD-approve → pay it by INJECTing a PayRunInputItem(kind=ARREAR) onto the open run
 *   OR MINTing a PayRun(type=ARREAR) through the SAME persist path bonus/FnF use.
 *
 * NO fork of the engine math: the per-month recompute calls the EXACT
 * service.buildEmployeePayInput + engine.computePayslip the live run uses, only with
 * the NEW compensation revision swapped in. The frozen AttendancePayInput of each
 * source month is reused verbatim (LOP/payable-days never re-derived).
 *
 * India-only (assertCountry). All amounts are INTEGER MINOR UNITS (paise); conversion
 * to Decimal only at the persistence edge. Idempotent (unwind-then-recompute), in-tx,
 * tenant-safe.
 */

const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');
const { assertCountry } = require('../tenant/countryContext');
const { notifyHrEvent } = require('../integrations/notifications');
const { allocateCode } = require('../lifecycle/lib/codes');
const arrearsCore = require('./arrears');
const { _internals: india } = require('./compliance/india');
const engine = require('./engine');
const service = require('./service');
const resolveCurrentCompensation = service._internal.resolveCurrentCompensation;
const { buildEmployeePayInput } = service;

class ArrearError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.reason = code;
  }
}

// ── pure persistence helpers (integer minor ↔ Decimal; never floats for money) ──
function minorToDecimal(minor) {
  const n = Math.round(Number(minor) || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
function toDateOnly(x) {
  if (!x) return null;
  const d = x instanceof Date ? x : new Date(x);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function isoDate(x) {
  const d = x instanceof Date ? x : new Date(x);
  return d.toISOString().slice(0, 10);
}
/** Indian FY label "YYYY-YY" for a Date (Apr–Mar). */
function taxYearForDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0=Jan
  const startY = m >= 3 ? y : y - 1; // Apr (3) onward → this calendar year
  return `${startY}-${String((startY + 1) % 100).padStart(2, '0')}`;
}

// ── engine-result → PayRunLine persistence (MINT path, finding #5) ──
// Mirror service.statutoryRollups / buildComponentRows so the minted ARREAR run's line
// carries the SAME statutory rollups (incl. TDS + PT now that the arrear runs through the
// engine) and every component the engine emitted. Kept local (not a service export) so the
// arrears code stays self-contained and there is no new service↔arrears require coupling.
function statutoryRollupsFromResult(r) {
  const byCode = {};
  const baseByCode = {};
  for (const d of r.employeeDeductions || []) {
    byCode[d.code] = d.amountMinor;
    if (d.baseMinor != null) baseByCode[d.code] = d.baseMinor;
  }
  for (const c of r.employerContributions || []) {
    byCode[c.code] = c.amountMinor;
    if (c.baseMinor != null) baseByCode[c.code] = c.baseMinor;
  }
  const pick = (...codes) => {
    for (const c of codes) if (byCode[c] != null) return minorToDecimal(byCode[c]);
    return null;
  };
  const pickBase = (...codes) => {
    for (const c of codes) if (baseByCode[c] != null) return minorToDecimal(baseByCode[c]);
    return null;
  };
  return {
    // The arrear's PF/ESI ride as EPF_ARREAR/ESI_ARREAR (precomputed per source month) —
    // surface them on the line's pf/esi columns too so filing reconciles, plus TDS + PT.
    pfEmployee: pick('EPF_ARREAR', 'EPF', 'EPF_EE'),
    pfEmployer: pick('EPF_ER_ARREAR', 'EPF_ER'),
    esiEmployee: pick('ESI_ARREAR', 'ESI', 'ESI_EE'),
    esiEmployer: pick('ESI_ER_ARREAR', 'ESI_ER'),
    pt: pick('PT'),
    lwfEmployee: pick('LWF', 'LWF_EE'),
    lwfEmployer: pick('LWF_ER'),
    tds: pick('TDS'),
    pfWagesBase: pickBase('EPF', 'EPF_EE', 'EPF_ER'),
    epsWagesBase: pickBase('EPS_ER', 'EPS'),
    edliWagesBase: pickBase('EDLI'),
  };
}

function buildMintComponentRows(businessId, payRunLineId, r) {
  const rows = [];
  let sort = 0;
  const row = (item, category, isStatutory) => ({
    businessId, payRunLineId,
    componentId: item.componentId || item.code,
    componentCode: item.code,
    componentName: item.label || item.code,
    category,
    amount: minorToDecimal(item.amountMinor),
    baseAmount: item.baseMinor != null ? minorToDecimal(item.baseMinor) : null,
    isStatutory,
    sortOrder: sort++,
  });
  for (const e of r.earnings || []) rows.push(row(e, 'EARNING', false));
  for (const d of r.employeeDeductions || []) rows.push(row(d, 'DEDUCTION', !!d.statutory));
  for (const c of r.employerContributions || []) rows.push(row(c, 'EMPLOYER_COST', true));
  return rows;
}

async function loadCycle(businessId, arrearCycleId, db = prisma) {
  const cycle = await db.arrearCycle.findFirst({ where: { id: arrearCycleId, businessId, deletedAt: null } });
  if (!cycle) throw new ArrearError('CYCLE_NOT_FOUND', 'Arrear cycle not found', 404);
  return cycle;
}

// ── 1. detectArrearCycles — list retro revisions with un-actioned arrears ──
/**
 * Find CompensationRevision rows with effectiveFrom < the open period's start that are
 * EFFECTIVE/APPROVED and not yet linked to an ArrearCycle. India-gated. Read-only.
 */
async function detectArrearCycles({ businessId, entityId, openPeriodStart }) {
  const entity = await prisma.entity.findFirst({ where: { id: entityId, businessId } });
  if (!entity) throw new ArrearError('ENTITY_NOT_FOUND', 'Entity not found', 404);
  if (entity.countryCode) await assertCountry(businessId, entity.countryCode);
  if (entity.countryCode !== 'IN') throw new ArrearError('COUNTRY_NOT_SUPPORTED', 'Auto-arrears applies to India only', 404);

  const openStart = toDateOnly(openPeriodStart);
  if (!openStart) throw new ArrearError('BAD_PERIOD', 'openPeriodStart is required (YYYY-MM-01)', 400);

  const revisions = await prisma.compensationRevision.findMany({
    where: {
      businessId, entityId,
      effectiveFrom: { lt: openStart },
      status: { in: ['EFFECTIVE', 'APPROVED'] },
    },
    orderBy: { effectiveFrom: 'asc' },
    include: { employee: { select: { id: true, firstName: true, lastName: true, code: true } } },
  });

  // Exclude revisions already linked to a cycle (the @@unique guarantees one per rev).
  const linked = new Set(
    (await prisma.arrearCycle.findMany({
      where: { businessId, deletedAt: null },
      select: { compensationRevisionId: true },
    })).map((r) => r.compensationRevisionId),
  );

  const out = [];
  for (const rev of revisions) {
    if (linked.has(rev.id)) continue;
    const window = arrearsCore.detectRetroWindow({ effectiveFrom: rev.effectiveFrom, openPeriodStart: openStart });
    if (!window.length) continue; // not actually retro for this open period
    out.push({
      compensationRevisionId: rev.id,
      employeeId: rev.employeeId,
      employee: rev.employee,
      revisionReason: rev.revisionReason,
      effectiveFrom: isoDate(rev.effectiveFrom),
      retroMonths: window,
      monthCount: window.length,
    });
  }
  return { entityId, openPeriodStart: isoDate(openStart), candidates: out };
}

// ── 2. createArrearCycle — exactly-once on (businessId, compensationRevisionId) ──
async function createArrearCycle({ businessId, actorId, compensationRevisionId, detectedInPeriod }) {
  if (!compensationRevisionId) throw new ArrearError('MISSING_FIELDS', 'compensationRevisionId is required', 400);
  const rev = await prisma.compensationRevision.findFirst({ where: { id: compensationRevisionId, businessId } });
  if (!rev) throw new ArrearError('REVISION_NOT_FOUND', 'Compensation revision not found', 404);

  const entity = await prisma.entity.findFirst({ where: { id: rev.entityId, businessId } });
  if (!entity) throw new ArrearError('ENTITY_NOT_FOUND', 'Entity not found', 404);
  if (entity.countryCode) await assertCountry(businessId, entity.countryCode);
  if (entity.countryCode !== 'IN') throw new ArrearError('COUNTRY_NOT_SUPPORTED', 'Auto-arrears applies to India only', 404);

  // detectedInPeriod defaults to the month AFTER the revision's effectiveFrom-elapsed
  // window — but the caller (the open run) passes the actual open period ("YYYY-MM").
  const detected = detectedInPeriod || arrearsCore.periodCodeOf(new Date());
  const openStart = arrearsCore.monthStart(detected);
  const window = arrearsCore.detectRetroWindow({ effectiveFrom: rev.effectiveFrom, openPeriodStart: openStart });
  if (!window.length) throw new ArrearError('NOT_RETRO', 'Revision is not effective-dated before the detected period (no arrears)', 422);

  // Receipt FY = the FY the arrear is PAID in (drives Form 10E vs 39).
  const taxYear = taxYearForDate(openStart);
  const esiOnArrears = arrearsCore.esiOnArrearsDefault(rev.revisionReason);

  try {
    const cycle = await prisma.arrearCycle.create({
      data: {
        businessId, entityId: rev.entityId, employeeId: rev.employeeId,
        compensationRevisionId, revisionReason: rev.revisionReason,
        effectiveFrom: toDateOnly(rev.effectiveFrom),
        detectedInPeriod: detected, taxYear, esiOnArrears,
        status: 'DRAFT',
        // SoD (finding #6): record the creator so approve can enforce approver ≠ creator.
        createdBy: actorId || null,
      },
    });
    await writeAudit({ businessId, actorId, action: 'arrears.cycle.create', entityType: 'ArrearCycle', entityId: cycle.id, meta: { compensationRevisionId, detected, retroMonths: window } });
    return cycle;
  } catch (e) {
    if (e && e.code === 'P2002') throw new ArrearError('CYCLE_EXISTS', 'An arrear cycle already exists for this revision', 409);
    throw e;
  }
}

// ── load a SPECIFIC CompensationRevision (with lines + components) ──
/** Load one CompensationRevision by id with its lines/components, or null. */
async function loadRevisionWithLines(businessId, revisionId, db = prisma) {
  if (!revisionId) return null;
  return db.compensationRevision.findFirst({
    where: { id: revisionId, businessId },
    include: { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } },
  });
}

/** Re-run the SAME pure engine at `compensation` with the month's FROZEN attendance. */
function recomputeAtComp({ employee, compensation, attendance, entity, monthStart, monthEnd, taxYear }) {
  const bundle = {
    employee,
    compensation,
    statutory: employee.statutoryProfile || null,
    attendance: attendance || null,
    entity,
    period: {
      start: isoDate(monthStart), end: isoDate(monthEnd), payDate: isoDate(monthEnd),
      frequency: null, taxYear, runType: 'REGULAR',
    },
    ytd: null,
  };
  const { engineArgs } = buildEmployeePayInput(bundle);
  return engine.computePayslip(engineArgs);
}

/**
 * frozenEsiCovered(snapshot) — derive the SOURCE month's actual ESI COVERAGE VERDICT
 * from the frozen payslip (finding #3): a non-zero ESI deduction (code 'ESI' /
 * 'ESI_EMPLOYEE') OR a non-zero employer ESI contribution ('ESI_ER' / 'ESI_EMPLOYER')
 * in the frozen snapshot means the employee WAS in the scheme that month. We do NOT
 * infer coverage from the ESI WAGE BASE (> ₹0): the engine sums ESI-flagged earnings
 * into bases.esiWagesMinor for EVERY employee regardless of the ceiling, so a >₹21k
 * (never-covered) worker still had a non-zero wage base. Fail-CLOSED: no ESI
 * deduction/contribution in the snapshot ⇒ NOT covered ⇒ no ESI charged on the arrear.
 */
function frozenEsiCovered(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const num = (x) => Math.round((typeof x === 'number' ? x : Number(x)) * 100) || 0;
  const eeCodes = new Set(['ESI', 'ESI_EMPLOYEE']);
  const erCodes = new Set(['ESI_ER', 'ESI_EMPLOYER']);
  const ded = Array.isArray(snapshot.employeeDeductions) ? snapshot.employeeDeductions : [];
  for (const d of ded) if (eeCodes.has(d.code) && num(d.amount) > 0) return true;
  const ec = Array.isArray(snapshot.employerContributions) ? snapshot.employerContributions : [];
  for (const c of ec) if (erCodes.has(c.code) && num(c.amount) > 0) return true;
  return false;
}

// ── recompute one source month at the CYCLE'S revision using its FROZEN attendance ──
/**
 * For a source "YYYY-MM": find the frozen paid Payslip + the frozen AttendancePayInput,
 * then diff the recompute at THE CYCLE'S OWN revision (cycle.compensationRevisionId)
 * against the recompute at the IMMEDIATELY-PRIOR revision (the baseline). PURE-ish:
 * reads frozen rows, calls the pure buildEmployeePayInput + computePayslip.
 *
 * FIX (finding #1): the recompute is PINNED to cycle.compensationRevisionId — NOT
 * resolveCurrentCompensation (the LATEST revision covering the month). With two retro
 * revisions R1→R2 both overlapping a month, the OLD code diffed BOTH cycles' recompute
 * at R2 (latest) vs the same frozen slip, booking the full R1→R2 delta TWICE. Now each
 * cycle recomputes at ITS OWN revision and diffs against the revision IMMEDIATELY PRIOR
 * to it, so R1 books R0→R1 and R2 books R1→R2 — each pays only its own incremental
 * delta, never the same month twice. When there is no prior revision (the cycle's
 * revision is the first/original), the baseline is the actual FROZEN paid slip.
 */
async function recomputeMonth({ businessId, cycle, sourcePeriod, db = prisma }) {
  const monthEnd = arrearsCore.monthEnd(sourcePeriod);
  const monthStart = arrearsCore.monthStart(sourcePeriod);

  // The FROZEN paid payslip for this month. Prefer a REGULAR run's slip.
  const paidSlip = await db.payslip.findFirst({
    where: {
      businessId, employeeId: cycle.employeeId,
      periodStart: { lte: monthEnd }, periodEnd: { gte: monthStart },
      deletedAt: null,
    },
    orderBy: { createdAt: 'desc' },
    include: { payRun: { select: { id: true, type: true, taxYear: true, currencyCode: true } } },
  });
  if (!paidSlip) {
    return { sourcePeriod, missingBaseline: true };
  }

  // The FROZEN attendance for that run (reused verbatim — never re-derived).
  const att = await db.attendancePayInput.findFirst({
    where: { businessId, payRunId: paidSlip.payRunId, employeeId: cycle.employeeId },
  });

  // The NEW compensation = the CYCLE'S OWN revision (NOT the latest covering this month).
  const newComp = await loadRevisionWithLines(businessId, cycle.compensationRevisionId, db);
  if (!newComp) return { sourcePeriod, missingBaseline: true };

  const employee = await db.employee.findFirst({ where: { id: cycle.employeeId, businessId }, include: { statutoryProfile: true } });
  const entity = await db.entity.findFirst({ where: { id: cycle.entityId, businessId } });
  const taxYear = paidSlip.payRun.taxYear;
  const frozen = paidSlip.snapshotJson || {};

  // NEW side — recompute at the cycle's own revision with THIS month's frozen attendance.
  const recomputed = recomputeAtComp({ employee, compensation: newComp, attendance: att, entity, monthStart, monthEnd, taxYear });

  // BASELINE side — the revision IMMEDIATELY PRIOR to the cycle's revision (resolve as of
  // the day BEFORE the cycle revision's effectiveFrom). If there is a distinct prior
  // revision, recompute at IT (so an R1→R2 chain books only R2's own delta on R2's
  // cycle); otherwise the baseline is the actual FROZEN paid slip (the original comp).
  const priorAsOf = new Date(toDateOnly(newComp.effectiveFrom).getTime() - 86400000); // −1 day
  const priorComp = await resolveCurrentCompensation(businessId, cycle.employeeId, isoDate(priorAsOf), db);

  let diff;
  if (priorComp && priorComp.id !== newComp.id) {
    // Engine-vs-engine: recompute the baseline at the prior revision, same frozen attendance.
    const baseline = recomputeAtComp({ employee, compensation: priorComp, attendance: att, entity, monthStart, monthEnd, taxYear });
    diff = arrearsCore.diffMonth({ recomputed, paid: baseline, paidShape: 'engine' });
  } else {
    // No prior revision → diff against the actual frozen paid snapshot (major units).
    diff = arrearsCore.diffMonth({ recomputed, paid: frozen, paidShape: 'snapshot' });
  }

  return {
    sourcePeriod,
    sourcePayRunId: paidSlip.payRunId,
    diff,
    recomputed,
    payableDays: att ? Number(att.payableDays) : 0,
    lopDays: att ? Number(att.lopDays) : 0,
    // PF/ESI wage bases (old=baseline, new=recomputed) for the per-source-month
    // statutory arrear. The arrears.js aggregate applies the ceiling per source month.
    oldPfWageMinor: diff.paidPfWageMinor,
    newPfWageMinor: diff.recomputedPfWageMinor,
    oldEsiWageMinor: diff.paidEsiWageMinor,
    newEsiWageMinor: diff.recomputedEsiWageMinor,
    // FIX (finding #3): the source month's ESI coverage verdict comes from the FROZEN
    // slip's actual ESI deduction/contribution (fail-closed), NOT from wage-base > 0.
    esiLatchedCovered: frozenEsiCovered(frozen),
  };
}

// ── 3. computeArrearCycle — idempotent per-month diff + aggregate + §89(1) ──
async function computeArrearCycle({ businessId, actorId, arrearCycleId }) {
  const cycle = await loadCycle(businessId, arrearCycleId);
  if (cycle.status === 'APPROVED' || cycle.status === 'PAID') {
    throw new ArrearError('BAD_STATE', `Compute requires a DRAFT/COMPUTED cycle (current: ${cycle.status})`, 409);
  }

  const openStart = arrearsCore.monthStart(cycle.detectedInPeriod);
  const window = arrearsCore.detectRetroWindow({ effectiveFrom: cycle.effectiveFrom, openPeriodStart: openStart });

  const monthResults = [];
  const warnings = [];
  for (const sourcePeriod of window) {
    const r = await recomputeMonth({ businessId, cycle, sourcePeriod });
    if (r.missingBaseline) {
      // No frozen baseline → surface a WARNING, treat as ₹0 arrear for that month (never
      // silently assume a payment). Flagged for operator review (spec §9).
      warnings.push({ code: 'NO_FROZEN_BASELINE', sourcePeriod, message: `No frozen payslip found for ${sourcePeriod}; skipped (review).` });
      continue;
    }
    monthResults.push(r);
  }

  // Aggregate the arrear + PF/ESI per source month (the ceiling applies per month).
  const agg = arrearsCore.aggregateArrear({
    esiOnArrears: cycle.esiOnArrears,
    india,
    months: monthResults.map((m) => ({
      sourcePeriod: m.sourcePeriod,
      deltaGrossMinor: m.diff.deltaGrossMinor,
      oldPfWageMinor: m.oldPfWageMinor, newPfWageMinor: m.newPfWageMinor,
      oldEsiWageMinor: m.oldEsiWageMinor, newEsiWageMinor: m.newEsiWageMinor,
      esiLatchedCovered: m.esiLatchedCovered,
    })),
  });

  // §89(1) relief data point: per SOURCE FY slice the arrear, vs the receipt FY.
  // The "other taxable" income figures are best-effort from the frozen payslips'
  // annualised gross (a precise figure needs the F15 projection; we surface the
  // arithmetic inputs so the worksheet is auditable). We attribute each month's gross
  // delta to its source FY.
  const sliceByFy = new Map();
  for (const m of monthResults) {
    const fy = taxYearForDate(arrearsCore.monthEnd(m.sourcePeriod));
    sliceByFy.set(fy, (sliceByFy.get(fy) || 0) + m.diff.deltaGrossMinor);
  }
  const sourceSlices = [...sliceByFy.entries()].map(([fy, sliceMinor]) => ({
    fy,
    sliceRupees: Math.round(sliceMinor / 100),
    // Best-effort prior taxable for the source FY: 0 baseline (the worksheet records the
    // slice + tax-with/without so the employee/CA can plug their actual figure). The
    // attribution per source FY (the spec's required data point) is exact.
    otherTaxableRupees: 0,
  }));
  const s89 = arrearsCore.computeS89Relief({
    india,
    receiptFY: cycle.taxYear,
    receiptYearOtherTaxableRupees: 0, // surfaced as a worksheet input; relief recomputed live in F15
    arrearRupees: Math.round(agg.grossArrearMinor / 100),
    sourceSlices,
  });

  // Persist: clear prior ArrearMonth rows + rewrite (idempotent), freeze COMPUTED.
  await prisma.$transaction(async (tx) => {
    await tx.arrearMonth.deleteMany({ where: { arrearCycleId } });
    for (const m of monthResults) {
      const per = agg.perMonth.find((p) => p.sourcePeriod === m.sourcePeriod) || {};
      await tx.arrearMonth.create({
        data: {
          businessId, arrearCycleId, sourcePeriod: m.sourcePeriod, sourcePayRunId: m.sourcePayRunId,
          paidGrossMinor: BigInt(m.diff.paidGrossMinor),
          recomputedGrossMinor: BigInt(m.diff.recomputedGrossMinor),
          deltaGrossMinor: BigInt(m.diff.deltaGrossMinor),
          paidPfWageMinor: BigInt(m.diff.paidPfWageMinor),
          recomputedPfWageMinor: BigInt(m.diff.recomputedPfWageMinor),
          deltaPfWageMinor: BigInt(m.diff.deltaPfWageMinor),
          paidEsiWageMinor: BigInt(m.diff.paidEsiWageMinor),
          recomputedEsiWageMinor: BigInt(m.diff.recomputedEsiWageMinor),
          deltaEsiWageMinor: BigInt(m.diff.deltaEsiWageMinor),
          pfArrearEeMinor: BigInt(per.pfEeMinor || 0),
          pfArrearErMinor: BigInt(per.pfErMinor || 0),
          esiArrearEeMinor: BigInt(per.esiEeMinor || 0),
          esiArrearErMinor: BigInt(per.esiErMinor || 0),
          componentDeltasJson: m.diff.componentDeltas,
          payableDays: String(Number(m.payableDays).toFixed(4)),
          lopDays: String(Number(m.lopDays).toFixed(4)),
        },
      });
    }
    await tx.arrearCycle.update({
      where: { id: arrearCycleId },
      data: {
        status: 'COMPUTED',
        grossArrearMinor: BigInt(agg.grossArrearMinor),
        pfArrearEeMinor: BigInt(agg.pfArrearEeMinor),
        pfArrearErMinor: BigInt(agg.pfArrearErMinor),
        esiArrearEeMinor: BigInt(agg.esiArrearEeMinor),
        esiArrearErMinor: BigInt(agg.esiArrearErMinor),
        s89ReliefMinor: BigInt(s89.reliefMinor),
        s89DatapointJson: s89.datapoint,
        computedAt: new Date(), computedBy: actorId,
        version: { increment: 1 },
      },
    });
  });

  await notifyHrEvent({ businessId, event: 'arrears.computed', triggeredBy: actorId, variables: { AMT: minorToDecimal(agg.grossArrearMinor), MONTHS: String(monthResults.length) } }).catch(() => {});
  await writeAudit({ businessId, actorId, action: 'arrears.cycle.compute', entityType: 'ArrearCycle', entityId: arrearCycleId, meta: { grossArrearMinor: agg.grossArrearMinor, months: monthResults.length, warnings } });

  return getArrearCycle({ businessId, arrearCycleId, warnings });
}

// ── 4. approveArrearCycle — SoD + INJECT (open run) or MINT (standalone run) ──
async function approveArrearCycle({ businessId, actorId, arrearCycleId, targetMode = 'INJECT', targetPayRunId = null }) {
  const cycle = await loadCycle(businessId, arrearCycleId);
  if (cycle.status !== 'COMPUTED') throw new ArrearError('BAD_STATE', `Approve requires a COMPUTED cycle (current: ${cycle.status})`, 409);
  // SoD (finding #6): the approver must differ from BOTH the maker (computedBy) AND the
  // creator (createdBy) — a single actor must never both author/compute the figure and
  // approve it. Fail-closed on an unknown maker. (createdBy may be null on a legacy cycle
  // created before this column; we only block when it IS recorded and equals the approver.)
  if (!cycle.computedBy) throw new ArrearError('SOD_MAKER_UNKNOWN', 'Cycle maker is unknown; cannot approve (fail-closed)', 403);
  if (cycle.computedBy === actorId) throw new ArrearError('MAKER_CHECKER', 'Maker-checker: the approver must differ from the employee who computed the cycle', 403);
  if (cycle.createdBy && cycle.createdBy === actorId) throw new ArrearError('MAKER_CHECKER', 'Maker-checker: the approver must differ from the employee who created the cycle', 403);
  if (cycle.payRunId) throw new ArrearError('ALREADY_PAID', 'Cycle already bound to a pay run', 409);

  // Downward (negative) arrear → a RECOVERY, gated as a BLOCKER confirm. Never auto-pay.
  if (Number(cycle.grossArrearMinor) < 0) {
    throw new ArrearError('NEGATIVE_ARREAR_BLOCKED', 'This revision reduces past pay (a recovery); recover only with an explicit operator-approved correction. Not auto-deducted.', 422);
  }
  if (Number(cycle.grossArrearMinor) === 0) {
    throw new ArrearError('ZERO_ARREAR', 'No arrear to pay (recompute produced a zero delta).', 422);
  }

  if (targetMode === 'INJECT') return approveInject({ businessId, actorId, cycle, targetPayRunId });
  if (targetMode === 'MINT') return approveMint({ businessId, actorId, cycle });
  throw new ArrearError('BAD_TARGET_MODE', "targetMode must be 'INJECT' or 'MINT'", 400);
}

// INJECT — bind to the open DRAFT regular run + write a PayRunInputItem(kind=ARREAR).
async function approveInject({ businessId, actorId, cycle, targetPayRunId }) {
  // Resolve the open DRAFT/INPUTS_LOCKED run for the entity in the detected period.
  let run;
  if (targetPayRunId) {
    run = await prisma.payRun.findFirst({ where: { id: targetPayRunId, businessId, entityId: cycle.entityId } });
  } else {
    run = await prisma.payRun.findFirst({
      where: {
        businessId, entityId: cycle.entityId, deletedAt: null,
        status: { in: ['DRAFT', 'INPUTS_LOCKED'] },
        type: { in: ['REGULAR', 'OFF_CYCLE'] },
      },
      orderBy: { periodStart: 'desc' },
    });
  }
  if (!run) throw new ArrearError('NO_OPEN_RUN', 'No open DRAFT run found to inject the arrear into; mint a separate ARREAR run instead.', 422);
  if (!['DRAFT', 'INPUTS_LOCKED'].includes(run.status)) {
    throw new ArrearError('RUN_NOT_OPEN', `Target run is ${run.status}; the arrear can only inject into a DRAFT/INPUTS_LOCKED run.`, 422);
  }

  const out = await prisma.$transaction(async (tx) => {
    const item = await tx.payRunInputItem.create({
      data: {
        businessId, payRunId: run.id, employeeId: cycle.employeeId,
        kind: 'ARREAR', componentCode: 'ARREAR_EARNINGS',
        amountMinor: cycle.grossArrearMinor, sourcePeriod: cycle.detectedInPeriod,
        taxable: true, note: `Auto-arrears (revision ${cycle.compensationRevisionId})`, createdBy: actorId,
      },
    });
    // Atomic single-bind guard: only a COMPUTED+unbound cycle transitions.
    const claim = await tx.arrearCycle.updateMany({
      where: { id: cycle.id, businessId, status: 'COMPUTED', payRunId: null },
      data: { status: 'APPROVED', targetMode: 'INJECT', payRunId: run.id, payRunInputItemId: item.id, approvedAt: new Date(), approvedBy: actorId, version: { increment: 1 } },
    });
    if (claim.count !== 1) throw new ArrearError('ALREADY_PAID', 'Cycle already bound to a pay run (lost the concurrent approve race)', 409);
    return { payRun: run, payRunInputItemId: item.id };
  });

  await writeAudit({ businessId, actorId, action: 'arrears.cycle.approve', entityType: 'ArrearCycle', entityId: cycle.id, meta: { targetMode: 'INJECT', payRunId: out.payRun.id } });
  return getArrearCycle({ businessId, arrearCycleId: cycle.id });
}

// MINT — a standalone PayRun(type=ARREAR) carrying the arrear earning + statutory comps.
// FIX (finding #5): the arrear gross is run THROUGH the ENGINE (engine.computePayslip via
// the SAME buildEmployeePayInput the live/INJECT path uses) so §192 TDS (annualised
// projection) and Professional Tax apply to the arrear — instead of the old hand-rolled
// net = gross − PF/ESI which silently withheld ZERO TDS and ZERO PT. The arrear's PF/ESI
// stay PRECOMPUTED per source month (carried as EPF_ARREAR/ESI_ARREAR passthroughs, NOT
// re-charged on the payout month) exactly as INJECT does. F21 LWF run-gate skips LWF on
// ARREAR. The minted run then completes its lifecycle (DRAFT→COMPUTED→APPROVED→PAID); the
// cycle is stamped PAID by disburseRun (stampArrearMintCyclesPaidForRun).
async function approveMint({ businessId, actorId, cycle }) {
  const cal = await prisma.payCalendar.findFirst({ where: { businessId, entityId: cycle.entityId, isActive: true } })
    || await prisma.payCalendar.findFirst({ where: { businessId, entityId: cycle.entityId } });
  if (!cal) throw new ArrearError('NO_PAY_CALENDAR', 'No pay calendar configured for the entity; cannot mint the arrear PayRun', 422);

  const openStart = arrearsCore.monthStart(cycle.detectedInPeriod);
  const openEnd = arrearsCore.monthEnd(cycle.detectedInPeriod);
  const grossMinor = Number(cycle.grossArrearMinor);

  // Build the arrear-ONLY engine input: NO regular salary lines (compensation.lines = [])
  // so we never re-pay the month's salary — just the ARREAR_EARNINGS line + the precomputed
  // PF/ESI passthroughs. buildEmployeePayInput's arrearInputs branch emits exactly the INJECT
  // component set; engine.computePayslip then adds §192 TDS + PT + net. This is the EXACT
  // engine path the live run uses, scoped to one employee and the arrear.
  const employee = await prisma.employee.findFirst({ where: { id: cycle.employeeId, businessId }, include: { statutoryProfile: true } });
  const entity = await prisma.entity.findFirst({ where: { id: cycle.entityId, businessId } });
  const { engineArgs } = buildEmployeePayInput({
    employee,
    compensation: { lines: [] }, // no regular salary on a standalone arrear run
    statutory: employee && employee.statutoryProfile ? employee.statutoryProfile : null,
    attendance: null,
    entity,
    period: {
      start: isoDate(openStart), end: isoDate(openEnd), payDate: isoDate(openEnd),
      frequency: cal.frequency || null, taxYear: cycle.taxYear, runType: 'ARREAR',
    },
    ytd: null,
    arrearInputs: {
      grossArrearMinor: grossMinor,
      pfArrearEeMinor: Number(cycle.pfArrearEeMinor),
      pfArrearErMinor: Number(cycle.pfArrearErMinor),
      esiArrearEeMinor: Number(cycle.esiArrearEeMinor),
      esiArrearErMinor: Number(cycle.esiArrearErMinor),
      isTaxable: true,
    },
  });
  const result = engine.computePayslip(engineArgs);

  // The engine's authoritative figures (TDS + PT now included in the deductions/net).
  const eeDed = result.totalEmployeeDeductionsMinor;
  const netMinor = result.netMinor;
  const erCost = result.totalEmployerContributionsMinor;
  const roll = statutoryRollupsFromResult(result);

  let out;
  try {
    out = await prisma.$transaction(async (tx) => {
      const code = await allocateCode(tx, { businessId, entityId: cycle.entityId, scope: 'ARREAR', prefix: 'ARR-', padding: 6 });
      const payRun = await tx.payRun.create({
        data: {
          businessId, entityId: cycle.entityId, payCalendarId: cal.id, code,
          periodStart: toDateOnly(openStart), periodEnd: toDateOnly(openEnd), payDate: toDateOnly(openEnd),
          sequenceInYear: 0, taxYear: cycle.taxYear,
          // DRAFT + already-computed: the minted run is created COMPUTED-ready (lines below)
          // then driven APPROVED→PAID through the normal run lifecycle (disburseRun stamps
          // the cycle PAID). We persist the engine totals here so the run is consistent.
          type: 'ARREAR', status: 'COMPUTED', currencyCode: 'INR',
          headcount: 1,
          totalGross: minorToDecimal(grossMinor),
          totalDeductions: minorToDecimal(eeDed),
          totalNet: minorToDecimal(netMinor),
          totalEmployerCost: minorToDecimal(erCost),
          notes: `Auto-arrears (revision ${cycle.compensationRevisionId}) — ${cycle.detectedInPeriod}`,
        },
      });
      const emp = await tx.employee.findUnique({ where: { id: cycle.employeeId }, select: { currentCompensationId: true } });
      const line = await tx.payRunLine.create({
        data: {
          businessId, payRunId: payRun.id, employeeId: cycle.employeeId,
          compensationId: emp && emp.currentCompensationId ? emp.currentCompensationId : '',
          payableDays: 0,
          grossEarnings: minorToDecimal(grossMinor),
          totalDeductions: minorToDecimal(eeDed),
          netPay: minorToDecimal(netMinor),
          employerCost: minorToDecimal(erCost),
          ...roll, // pfEmployee/pfEmployer/esiEmployee/esiEmployer/pt/tds/... from the engine result
          currencyCode: 'INR', status: 'COMPUTED',
        },
      });
      // Persist EVERY engine component (ARREAR_EARNINGS + EPF/ESI passthroughs + TDS + PT).
      const comps = buildMintComponentRows(businessId, line.id, result);
      if (comps.length) await tx.payRunLineComponent.createMany({ data: comps });

      // Atomic single-mint guard (mirror bonus.service): only a COMPUTED+unbound cycle mints.
      const claim = await tx.arrearCycle.updateMany({
        where: { id: cycle.id, businessId, status: 'COMPUTED', payRunId: null },
        data: { status: 'APPROVED', targetMode: 'MINT', payRunId: payRun.id, approvedAt: new Date(), approvedBy: actorId, version: { increment: 1 } },
      });
      if (claim.count !== 1) throw new ArrearError('ALREADY_PAID', 'Cycle already minted an arrear PayRun (lost the concurrent approve race)', 409);
      return { payRun, netMinor };
    });
  } catch (e) {
    const isConcLoss = (e instanceof ArrearError && e.code === 'ALREADY_PAID') || (e && (e.code === 'P2002' || e.code === 'P2034'));
    if (isConcLoss) {
      const now = await prisma.arrearCycle.findFirst({ where: { id: cycle.id, businessId }, select: { payRunId: true } });
      if (now && now.payRunId) throw new ArrearError('ALREADY_PAID', 'Cycle already minted an arrear PayRun (lost the concurrent approve race)', 409);
    }
    throw e;
  }

  await writeAudit({ businessId, actorId, action: 'arrears.cycle.approve', entityType: 'ArrearCycle', entityId: cycle.id, meta: { targetMode: 'MINT', payRunId: out.payRun.id, netMinor } });
  return getArrearCycle({ businessId, arrearCycleId: cycle.id });
}

// ── PATCH — toggle esiOnArrears / edit notes (DRAFT/COMPUTED only) ──
async function updateArrearCycle({ businessId, actorId, arrearCycleId, esiOnArrears, notes }) {
  const cycle = await loadCycle(businessId, arrearCycleId);
  if (cycle.status === 'APPROVED' || cycle.status === 'PAID' || cycle.status === 'CANCELLED') {
    throw new ArrearError('BAD_STATE', `Cannot edit a ${cycle.status} cycle`, 409);
  }
  const data = { version: { increment: 1 } };
  if (notes !== undefined) data.notes = notes;

  // FIX (finding #6): esiOnArrears is an economically MATERIAL input (whether ESI is
  // charged on the whole arrear). The persisted PF/ESI figures were FROZEN at compute
  // time, so flipping the flag post-compute would change the displayed gate WITHOUT
  // recomputing the amounts — the checker would approve "ESI off" while the stored
  // esiArrearEe/Er still carry the ESI charge (or vice-versa). To keep the gate and the
  // paid figure in lock-step we INVALIDATE the computation when the flag actually
  // changes on a COMPUTED cycle: status → DRAFT and computedBy/computedAt cleared, so a
  // fresh SoD-checked compute (which re-derives the figures under the new flag) and a
  // fresh approve are required before it can be paid.
  let invalidated = false;
  if (typeof esiOnArrears === 'boolean' && esiOnArrears !== cycle.esiOnArrears) {
    data.esiOnArrears = esiOnArrears;
    if (cycle.status === 'COMPUTED') {
      data.status = 'DRAFT';
      data.computedBy = null;
      data.computedAt = null;
      invalidated = true;
    }
  } else if (typeof esiOnArrears === 'boolean') {
    // No-op flag write (same value) — set it harmlessly, never invalidate.
    data.esiOnArrears = esiOnArrears;
  }

  await prisma.arrearCycle.update({ where: { id: arrearCycleId }, data });
  await writeAudit({ businessId, actorId, action: 'arrears.cycle.update', entityType: 'ArrearCycle', entityId: arrearCycleId, meta: { esiOnArrears, notesChanged: notes !== undefined, computeInvalidated: invalidated } });
  return getArrearCycle({ businessId, arrearCycleId });
}

// ── cancelArrearCycle — release any binding + soft-cancel so the revision can regenerate ──
/**
 * cancelArrearCycle (FIX, finding #2): the missing function arrearsPass.js referenced.
 * Cancels an arrear cycle that has NOT yet been paid, releasing any binding so the
 * obligation is never stranded behind the @@unique:
 *   - DRAFT / COMPUTED (unbound)         → CANCELLED + soft-deleted.
 *   - APPROVED + INJECT (run not paid)   → delete the orphan PayRunInputItem(kind=ARREAR),
 *                                          then CANCELLED + soft-deleted.
 *   - APPROVED + MINT (run not paid)     → cancel the minted standalone ARREAR PayRun
 *                                          (it exists only for this cycle), then CANCELLED.
 *   - PAID, or bound to a PAID/FILED run → refused (create a compensating CORRECTION).
 * The cycle is SOFT-DELETED (deletedAt set) on cancel so the partial-unique index (which
 * now excludes soft-deleted rows) lets a fresh cycle be detected + created for the SAME
 * revision later — a cancelled/regenerated arrear is never permanently stranded.
 */
async function cancelArrearCycle({ businessId, actorId, arrearCycleId, reason = null }) {
  const cycle = await loadCycle(businessId, arrearCycleId);
  if (cycle.status === 'PAID') {
    throw new ArrearError('CANNOT_CANCEL', 'A PAID arrear cannot be cancelled; reverse it with a compensating CORRECTION run.', 409);
  }
  if (cycle.status === 'CANCELLED') {
    throw new ArrearError('BAD_STATE', 'Arrear cycle is already cancelled', 409);
  }

  // If bound to a run, the run must NOT already be PAID/FILED/CLOSED (money already moved).
  if (cycle.payRunId) {
    const run = await prisma.payRun.findFirst({ where: { id: cycle.payRunId, businessId } });
    if (run && ['PAID', 'FILED'].includes(run.status)) {
      throw new ArrearError('CANNOT_CANCEL', `The arrear is bound to a ${run.status} run; reverse it with a compensating CORRECTION run.`, 409);
    }
  }

  await prisma.$transaction(async (tx) => {
    if (cycle.payRunId) {
      if (cycle.targetMode === 'INJECT') {
        // Drop the orphan injected input item this cycle carried (its money never paid).
        if (cycle.payRunInputItemId) {
          await tx.payRunInputItem.deleteMany({ where: { id: cycle.payRunInputItemId, businessId } });
        } else {
          await tx.payRunInputItem.deleteMany({ where: { businessId, payRunId: cycle.payRunId, employeeId: cycle.employeeId, kind: 'ARREAR' } });
        }
      } else if (cycle.targetMode === 'MINT') {
        // The minted standalone ARREAR run exists ONLY for this cycle — cancel it.
        await tx.payRunLineComponent.deleteMany({ where: { payRunLine: { payRunId: cycle.payRunId } } });
        await tx.payRunLine.deleteMany({ where: { payRunId: cycle.payRunId } });
        await tx.payRun.updateMany({ where: { id: cycle.payRunId, businessId, status: { notIn: ['PAID', 'FILED'] } }, data: { status: 'CANCELLED' } });
      }
    }
    await tx.arrearCycle.update({
      where: { id: arrearCycleId },
      data: {
        status: 'CANCELLED', payRunId: null, payRunInputItemId: null, targetMode: null,
        approvedAt: null, approvedBy: null, deletedAt: new Date(), version: { increment: 1 },
      },
    });
  });

  await writeAudit({ businessId, actorId, action: 'arrears.cycle.cancel', entityType: 'ArrearCycle', entityId: arrearCycleId, meta: { reason: reason || null, from: cycle.status, wasBoundTo: cycle.payRunId || null, targetMode: cycle.targetMode || null } });
  return { arrearCycleId, status: 'CANCELLED' };
}

// ── 5. publishArrearSlips — fan out arrears.published + the §89(1) figure ──
async function publishArrearSlips({ businessId, actorId, arrearCycleId }) {
  const cycle = await loadCycle(businessId, arrearCycleId);
  const employee = await prisma.employee.findFirst({ where: { id: cycle.employeeId, businessId }, select: { firstName: true, workEmail: true, personalEmail: true, phone: true } });
  const formName = arrearsCore.resolveReliefFormName(cycle.taxYear);
  let notified = 0;
  try {
    await notifyHrEvent({
      businessId, event: 'arrears.published', triggeredBy: actorId,
      recipientEmail: employee ? (employee.workEmail || employee.personalEmail || undefined) : undefined,
      recipientPhone: employee ? (employee.phone || undefined) : undefined,
      variables: {
        NAME: employee ? (employee.firstName || 'there') : 'there',
        AMT: minorToDecimal(Number(cycle.grossArrearMinor)),
        RELIEF: minorToDecimal(Number(cycle.s89ReliefMinor || 0)),
        FORM: formName,
      },
    });
    notified = 1;
  } catch (_) { /* a notification failure must not abort */ }
  await writeAudit({ businessId, actorId, action: 'arrears.cycle.publish', entityType: 'ArrearCycle', entityId: arrearCycleId, meta: { notified, formName } });
  return { arrearCycleId, notified, formName };
}

// ── reads ──
async function listArrearCycles({ businessId, entityId, status }) {
  const where = { businessId, deletedAt: null };
  if (entityId) where.entityId = entityId;
  if (status) where.status = status;
  const cycles = await prisma.arrearCycle.findMany({
    where, orderBy: { createdAt: 'desc' },
    include: { employee: { select: { id: true, firstName: true, lastName: true, code: true } } },
  });
  return cycles.map(serializeCycle);
}

async function getArrearCycle({ businessId, arrearCycleId, warnings = [] }) {
  const cycle = await prisma.arrearCycle.findFirst({
    where: { id: arrearCycleId, businessId, deletedAt: null },
    include: {
      employee: { select: { id: true, firstName: true, lastName: true, code: true } },
      months: { orderBy: { sourcePeriod: 'asc' } },
    },
  });
  if (!cycle) throw new ArrearError('CYCLE_NOT_FOUND', 'Arrear cycle not found', 404);
  return { ...serializeCycle(cycle), months: cycle.months.map(serializeMonth), warnings };
}

// ── ESS — an employee's own arrear slips + §89(1) figure ──
async function getMyArrears({ businessId, employeeId }) {
  const cycles = await prisma.arrearCycle.findMany({
    where: { businessId, employeeId, status: { in: ['APPROVED', 'PAID'] }, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: { months: { orderBy: { sourcePeriod: 'asc' } } },
  });
  return cycles.map((c) => ({
    ...serializeCycle(c),
    months: c.months.map(serializeMonth),
    formName: arrearsCore.resolveReliefFormName(c.taxYear),
  }));
}

function serializeCycle(c) {
  return {
    id: c.id, businessId: c.businessId, entityId: c.entityId, employeeId: c.employeeId,
    employee: c.employee || undefined,
    compensationRevisionId: c.compensationRevisionId, revisionReason: c.revisionReason,
    effectiveFrom: isoDate(c.effectiveFrom), detectedInPeriod: c.detectedInPeriod, taxYear: c.taxYear,
    esiOnArrears: c.esiOnArrears, status: c.status, targetMode: c.targetMode || null,
    grossArrearMinor: Number(c.grossArrearMinor),
    pfArrearEeMinor: Number(c.pfArrearEeMinor), pfArrearErMinor: Number(c.pfArrearErMinor),
    esiArrearEeMinor: Number(c.esiArrearEeMinor), esiArrearErMinor: Number(c.esiArrearErMinor),
    s89ReliefMinor: c.s89ReliefMinor != null ? Number(c.s89ReliefMinor) : null,
    s89Datapoint: c.s89DatapointJson || null,
    reliefFormName: arrearsCore.resolveReliefFormName(c.taxYear),
    payRunId: c.payRunId || null, notes: c.notes || null,
    // SoD provenance (finding #6): surface creator + computer so the checker UI shows them.
    createdBy: c.createdBy || null, computedBy: c.computedBy || null, approvedBy: c.approvedBy || null,
    computedAt: c.computedAt, approvedAt: c.approvedAt,
  };
}
function serializeMonth(m) {
  return {
    sourcePeriod: m.sourcePeriod, sourcePayRunId: m.sourcePayRunId,
    paidGrossMinor: Number(m.paidGrossMinor), recomputedGrossMinor: Number(m.recomputedGrossMinor),
    deltaGrossMinor: Number(m.deltaGrossMinor),
    deltaPfWageMinor: Number(m.deltaPfWageMinor), deltaEsiWageMinor: Number(m.deltaEsiWageMinor),
    pfArrearEeMinor: Number(m.pfArrearEeMinor), pfArrearErMinor: Number(m.pfArrearErMinor),
    esiArrearEeMinor: Number(m.esiArrearEeMinor), esiArrearErMinor: Number(m.esiArrearErMinor),
    componentDeltas: m.componentDeltasJson || [],
    payableDays: Number(m.payableDays), lopDays: Number(m.lopDays),
  };
}

module.exports = {
  detectArrearCycles,
  createArrearCycle,
  computeArrearCycle,
  approveArrearCycle,
  updateArrearCycle,
  cancelArrearCycle,
  publishArrearSlips,
  listArrearCycles,
  getArrearCycle,
  getMyArrears,
  ArrearError,
  // exposed for tests
  _internal: { recomputeMonth, taxYearForDate, frozenEsiCovered },
};
