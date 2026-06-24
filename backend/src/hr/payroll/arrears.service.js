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
      },
    });
    await writeAudit({ businessId, actorId, action: 'arrears.cycle.create', entityType: 'ArrearCycle', entityId: cycle.id, meta: { compensationRevisionId, detected, retroMonths: window } });
    return cycle;
  } catch (e) {
    if (e && e.code === 'P2002') throw new ArrearError('CYCLE_EXISTS', 'An arrear cycle already exists for this revision', 409);
    throw e;
  }
}

// ── recompute one source month at the NEW comp using its FROZEN attendance ──
/**
 * For a source "YYYY-MM": find the frozen paid Payslip (baseline) + the frozen
 * AttendancePayInput, re-run the engine at the NEW comp, return { month, diff,
 * recomputed, frozenSnapshot, oldPfWageMinor, newPfWageMinor, ... }. PURE-ish:
 * reads frozen rows, calls the pure buildEmployeePayInput + computePayslip.
 */
async function recomputeMonth({ businessId, cycle, sourcePeriod, db = prisma }) {
  const monthEnd = arrearsCore.monthEnd(sourcePeriod);
  const monthStart = arrearsCore.monthStart(sourcePeriod);

  // The FROZEN paid payslip for this month (the baseline). Prefer a REGULAR run's slip.
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

  // The NEW compensation effective on the source month-end (the retro revision).
  const newComp = await resolveCurrentCompensation(businessId, cycle.employeeId, isoDate(monthEnd), db);
  if (!newComp) return { sourcePeriod, missingBaseline: true };

  const employee = await db.employee.findFirst({ where: { id: cycle.employeeId, businessId }, include: { statutoryProfile: true } });
  const entity = await db.entity.findFirst({ where: { id: cycle.entityId, businessId } });

  // Re-run the SAME pure engine at the NEW comp with THIS month's FROZEN attendance.
  const bundle = {
    employee,
    compensation: newComp,
    statutory: employee.statutoryProfile || null,
    attendance: att || null,
    entity,
    period: {
      start: isoDate(monthStart), end: isoDate(monthEnd), payDate: isoDate(monthEnd),
      frequency: null, taxYear: paidSlip.payRun.taxYear, runType: 'REGULAR',
    },
    ytd: null,
  };
  const { engineArgs } = buildEmployeePayInput(bundle);
  const recomputed = engine.computePayslip(engineArgs);

  // Diff recomputed (minor) vs the frozen snapshot (major units).
  const frozen = paidSlip.snapshotJson || {};
  const diff = arrearsCore.diffMonth({ recomputed, paid: frozen, paidShape: 'snapshot' });

  return {
    sourcePeriod,
    sourcePayRunId: paidSlip.payRunId,
    diff,
    recomputed,
    payableDays: att ? Number(att.payableDays) : 0,
    lopDays: att ? Number(att.lopDays) : 0,
    // PF/ESI wage bases (old=frozen snapshot, new=recomputed) for the per-source-month
    // statutory arrear. The arrears.js aggregate applies the ceiling per source month.
    oldPfWageMinor: diff.paidPfWageMinor,
    newPfWageMinor: diff.recomputedPfWageMinor,
    oldEsiWageMinor: diff.paidEsiWageMinor,
    newEsiWageMinor: diff.recomputedEsiWageMinor,
    // The source month's ESI coverage latch (was it covered then?).
    esiLatchedCovered: diff.paidEsiWageMinor > 0,
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
  // SoD: approver ≠ maker (computedBy). Fail-closed on unknown maker.
  if (!cycle.computedBy) throw new ArrearError('SOD_MAKER_UNKNOWN', 'Cycle maker is unknown; cannot approve (fail-closed)', 403);
  if (cycle.computedBy === actorId) throw new ArrearError('MAKER_CHECKER', 'Maker-checker: the approver must differ from the employee who computed the cycle', 403);
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

// MINT — a standalone PayRun(type=ARREAR) carrying the arrear earning + statutory comps
// (exactly how bonus.service mints STAT_BONUS). F21 LWF run-gate already skips LWF on ARREAR.
async function approveMint({ businessId, actorId, cycle }) {
  const cal = await prisma.payCalendar.findFirst({ where: { businessId, entityId: cycle.entityId, isActive: true } })
    || await prisma.payCalendar.findFirst({ where: { businessId, entityId: cycle.entityId } });
  if (!cal) throw new ArrearError('NO_PAY_CALENDAR', 'No pay calendar configured for the entity; cannot mint the arrear PayRun', 422);

  const openStart = arrearsCore.monthStart(cycle.detectedInPeriod);
  const openEnd = arrearsCore.monthEnd(cycle.detectedInPeriod);
  const grossMinor = Number(cycle.grossArrearMinor);
  const eeDed = Number(cycle.pfArrearEeMinor) + Number(cycle.esiArrearEeMinor);
  const netMinor = grossMinor - eeDed;
  const erCost = Number(cycle.pfArrearErMinor) + Number(cycle.esiArrearErMinor);

  let out;
  try {
    out = await prisma.$transaction(async (tx) => {
      const code = await allocateCode(tx, { businessId, entityId: cycle.entityId, scope: 'ARREAR', prefix: 'ARR-', padding: 6 });
      const payRun = await tx.payRun.create({
        data: {
          businessId, entityId: cycle.entityId, payCalendarId: cal.id, code,
          periodStart: toDateOnly(openStart), periodEnd: toDateOnly(openEnd), payDate: toDateOnly(openEnd),
          sequenceInYear: 0, taxYear: cycle.taxYear,
          type: 'ARREAR', status: 'DRAFT', currencyCode: 'INR',
          headcount: 1,
          totalGross: minorToDecimal(grossMinor),
          totalDeductions: minorToDecimal(eeDed),
          totalNet: minorToDecimal(netMinor),
          totalEmployerCost: minorToDecimal(erCost),
          approvedAt: new Date(), approvedBy: actorId,
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
          pfEmployee: minorToDecimal(Number(cycle.pfArrearEeMinor)),
          pfEmployer: minorToDecimal(Number(cycle.pfArrearErMinor)),
          esiEmployee: minorToDecimal(Number(cycle.esiArrearEeMinor)),
          esiEmployer: minorToDecimal(Number(cycle.esiArrearErMinor)),
          currencyCode: 'INR', status: 'COMPUTED',
        },
      });
      const comps = [{
        businessId, payRunLineId: line.id, componentId: 'ARREAR_EARNINGS', componentCode: 'ARREAR_EARNINGS',
        componentName: 'Salary arrears (retro revision)', category: 'EARNING',
        amount: minorToDecimal(grossMinor), isStatutory: false, sortOrder: 0,
      }];
      let sort = 1;
      if (Number(cycle.pfArrearEeMinor) > 0) comps.push({ businessId, payRunLineId: line.id, componentId: 'EPF_ARREAR', componentCode: 'EPF_ARREAR', componentName: 'EPF on arrears', category: 'DEDUCTION', amount: minorToDecimal(Number(cycle.pfArrearEeMinor)), isStatutory: true, sortOrder: sort++ });
      if (Number(cycle.esiArrearEeMinor) > 0) comps.push({ businessId, payRunLineId: line.id, componentId: 'ESI_ARREAR', componentCode: 'ESI_ARREAR', componentName: 'ESI on arrears', category: 'DEDUCTION', amount: minorToDecimal(Number(cycle.esiArrearEeMinor)), isStatutory: true, sortOrder: sort++ });
      if (Number(cycle.pfArrearErMinor) > 0) comps.push({ businessId, payRunLineId: line.id, componentId: 'EPF_ER_ARREAR', componentCode: 'EPF_ER_ARREAR', componentName: 'Employer EPF on arrears', category: 'EMPLOYER_COST', amount: minorToDecimal(Number(cycle.pfArrearErMinor)), isStatutory: true, sortOrder: sort++ });
      if (Number(cycle.esiArrearErMinor) > 0) comps.push({ businessId, payRunLineId: line.id, componentId: 'ESI_ER_ARREAR', componentCode: 'ESI_ER_ARREAR', componentName: 'Employer ESI on arrears', category: 'EMPLOYER_COST', amount: minorToDecimal(Number(cycle.esiArrearErMinor)), isStatutory: true, sortOrder: sort++ });
      await tx.payRunLineComponent.createMany({ data: comps });

      // Atomic single-mint guard (mirror bonus.service): only a COMPUTED+unbound cycle mints.
      const claim = await tx.arrearCycle.updateMany({
        where: { id: cycle.id, businessId, status: 'COMPUTED', payRunId: null },
        data: { status: 'APPROVED', targetMode: 'MINT', payRunId: payRun.id, approvedAt: new Date(), approvedBy: actorId, version: { increment: 1 } },
      });
      if (claim.count !== 1) throw new ArrearError('ALREADY_PAID', 'Cycle already minted an arrear PayRun (lost the concurrent approve race)', 409);
      return { payRun };
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
  if (typeof esiOnArrears === 'boolean') data.esiOnArrears = esiOnArrears;
  if (notes !== undefined) data.notes = notes;
  await prisma.arrearCycle.update({ where: { id: arrearCycleId }, data });
  await writeAudit({ businessId, actorId, action: 'arrears.cycle.update', entityType: 'ArrearCycle', entityId: arrearCycleId, meta: { esiOnArrears, notesChanged: notes !== undefined } });
  return getArrearCycle({ businessId, arrearCycleId });
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
  publishArrearSlips,
  listArrearCycles,
  getArrearCycle,
  getMyArrears,
  ArrearError,
  // exposed for tests
  _internal: { recomputeMonth, taxYearForDate },
};
