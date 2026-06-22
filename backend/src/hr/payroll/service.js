'use strict';

/**
 * service.js — payroll ORCHESTRATOR.
 *
 * Bridges the PURE payroll core (engine + state machine + compliance registry +
 * filing) to the Prisma database. This is the ONLY payroll layer (besides
 * payrun.js's thin persistence helpers) that touches the DB.
 *
 * Design rules honoured here:
 *   - The DB-row -> engine-input MAPPING lives in a PURE, exported function
 *     `buildEmployeePayInput(rows)` so it is unit-testable WITHOUT a DB.
 *   - All money stays INTEGER MINOR UNITS through the engine; conversion to
 *     Decimal happens only in payrun.js's persistence helpers (fromMinor).
 *   - Tenant scope (businessId) is threaded on every query.
 *   - The engine / compliance / filing modules are CONSUMED, never edited.
 *
 * Contract implemented (see the build brief):
 *   createRun, computeRun, approveRun, listRuns, getRun, getRunPayslips,
 *   getPayslip, getMyPayslips, getMyPayslip, generateFile.
 */

const prisma = require('../../core/lib/prisma');
const money = require('./money');
const engine = require('./engine');
const payrun = require('./payrun');
const registry = require('./complianceRegistry');
const filing = require('./filing');

const india = require('./compliance/india');
const newzealand = require('./compliance/newzealand');

const { CATEGORY, CALC, PRORATION, LOP_BEHAVIOR, computePayslip } = engine;
const { STATE, PayRunError, transition, computeInputHash } = payrun;

const ENGINE_VERSION = '1.0.0';

// Register the bundled compliance modules once (the in-memory registry seam).
// Idempotent: re-registering a (country, effectiveFrom) replaces it. The core
// never imports these by name — it resolves them through the registry.
for (const mod of [india, newzealand]) {
  if (!registry.hasComplianceModule(mod.country)) {
    registry.registerComplianceModule(mod);
  }
}

// ===========================================================================
//  PURE MAPPING LAYER — buildEmployeePayInput(rows)
//
//  Converts a bundle of DB rows for ONE employee into the exact argument
//  object computePayslip(args) expects. NO prisma, NO I/O, NO Date.now — pure
//  function of its inputs, unit-testable to the paise/cent.
// ===========================================================================

// Prisma ProrationMethod -> engine PRORATION.*
const PRORATION_MAP = Object.freeze({
  CALENDAR_DAYS: PRORATION.CALENDAR_DAYS,
  WORKING_DAYS: PRORATION.WORKING_DAYS,
  THIRTY_DAY_STANDARD: PRORATION.FIXED_30,
  NONE: PRORATION.NONE,
});

// Prisma ComponentCalcMethod -> engine CALC.* (for engine-evaluated components).
// STATUTORY components are NOT engine-evaluated (the compliance module emits
// them), so they are dropped from the component list handed to the engine.
const CALC_MAP = Object.freeze({
  FLAT: CALC.FIXED,
  PERCENT_OF: CALC.PERCENT_OF_BASE,
  FORMULA: CALC.ATTENDANCE_DRIVEN, // overtime / hours-driven earnings
  BALANCING: CALC.BALANCE_RECOVERY,
  // SLAB / STATUTORY -> handled by the compliance module, skipped here.
});

/**
 * Coerce a Decimal | number | numeric-string | null to integer minor units.
 * Pure string-based conversion via money.toMinor so no float drift creeps in.
 * Returns 0 for null/undefined/empty.
 */
function decimalToMinor(value, scale = 2) {
  if (value == null || value === '') return 0;
  let s;
  if (typeof value === 'object' && typeof value.toFixed === 'function') {
    // Prisma Decimal / Decimal.js — render to a fixed string at the scale.
    s = value.toFixed(scale);
  } else if (typeof value === 'number') {
    s = value.toFixed(scale);
  } else {
    s = String(value);
  }
  return money.toMinor(s, scale);
}

/** Number coercion for non-money quantities (days/hours/percent). */
function toNum(value, dflt = 0) {
  if (value == null || value === '') return dflt;
  if (typeof value === 'object' && typeof value.toNumber === 'function') {
    const n = value.toNumber();
    return Number.isFinite(n) ? n : dflt;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : dflt;
}

/** YYYY-MM-DD from a Date | ISO string | null. */
function isoDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return m ? m[1] : String(value);
}

/**
 * Map one resolved comp line (SalaryComponentLine joined to its SalaryComponent)
 * to an engine component def. Returns null for STATUTORY/SLAB lines (the
 * compliance module owns those) so they are excluded from the engine's set.
 */
function mapComponentLine(line, order) {
  const comp = line.component || {};
  const calcMethod = line.calcMethod || comp.calcMethod;
  // Statutory + slab components are computed by the compliance module, not the
  // engine. Drop them so they don't double-count.
  if (calcMethod === 'STATUTORY' || calcMethod === 'SLAB') return null;

  const engineCalc = CALC_MAP[calcMethod];
  if (!engineCalc) return null;

  const category = comp.category || 'EARNING';
  const prorationPolicy = PRORATION_MAP[comp.prorationMethod || 'CALENDAR_DAYS'] || PRORATION.CALENDAR_DAYS;
  const lopBehavior =
    (comp.prorationMethod === 'NONE' || comp.isRecurring === false)
      ? LOP_BEHAVIOR.FIXED_REGARDLESS
      : LOP_BEHAVIOR.REDUCES_WITH_LOP;

  const def = {
    code: comp.code,
    name: comp.name || comp.code,
    componentId: comp.id,
    category,
    calcMethod: engineCalc,
    prorationPolicy,
    lopBehavior,
    showOnPayslip: true,
    _order: order,
    // statutory wage flags drive the bases the engine derives (name-agnostic).
    isBasic: comp.kind === 'BASIC' || comp.kind === 'DEARNESS_ALLOWANCE',
    isPfWages: comp.isWageForPF === true || comp.kind === 'BASIC' || comp.kind === 'DEARNESS_ALLOWANCE',
    isEsiWages: comp.isWageForESI === true,
    isPtWages: comp.isWageForPT === true,
    isGratuityWages: comp.isWageForGratuity === true,
    isTaxable: comp.isTaxable !== false,
    isPayeable: comp.isPayeable !== false,
    isKiwiSaverable: comp.isKiwiSaverable === true,
    // NZ gross-earnings flag: any payeable earning counts unless told otherwise.
    isNzGrossEarnings: category === 'EARNING',
  };

  // Wire calc-method-specific fields.
  if (engineCalc === CALC.FIXED || engineCalc === CALC.BALANCE_RECOVERY) {
    def.amountMinor = decimalToMinor(line.amountMonthly != null ? line.amountMonthly : line.calcValue);
  } else if (engineCalc === CALC.PERCENT_OF_BASE) {
    def.percent = toNum(line.calcValue);
    def.baseCode = comp.calcBaseCode || 'GROSS';
  } else if (engineCalc === CALC.ATTENDANCE_DRIVEN) {
    // FORMULA earnings driven by hours (e.g. OT). calcValue = rate per hour.
    def.ratePerHourMinor = decimalToMinor(line.calcValue);
    def.hoursField = 'otHours';
  }

  return def;
}

/**
 * buildEmployeePayInput(rows) — PURE mapping.
 *
 * @param {Object} rows {
 *   employee:      { id, gender, dateOfBirth, ... },
 *   compensation:  { id, lines:[ SalaryComponentLine + component ] },
 *   statutory:     StatutoryProfile | null,
 *   attendance:    AttendancePayInput | null,
 *   entity:        Entity { countryCode, stateCode, payCurrency, ... },
 *   period:        { start, end, payDate, frequency, taxYear },
 *   ytd:           Object | null,
 * }
 * @returns {Object} {
 *   componentsForEngine,  // engine component defs (statutory excluded)
 *   engineArgs,           // the exact computePayslip(args) argument object
 *   meta,                 // { employeeId, compensationId, payableDays, lopDays, overtimeHours }
 * }
 */
function buildEmployeePayInput(rows) {
  const {
    employee = {},
    compensation = {},
    statutory = null,
    attendance = null,
    entity = {},
    period = {},
    ytd = null,
  } = rows || {};

  // ── Components (engine-evaluated only) ──
  const compLines = Array.isArray(compensation.lines) ? compensation.lines : [];
  const componentsForEngine = [];
  let order = 0;
  for (const line of compLines) {
    const def = mapComponentLine(line, order);
    if (def) {
      componentsForEngine.push(def);
      order += 1;
    }
  }

  // ── Inputs (proration / LOP / overtime) from the frozen AttendancePayInput ──
  const inputs = {};
  if (attendance) {
    const calendarDays = toNum(attendance.calendarDays);
    const payableDays = toNum(attendance.payableDays);
    const lopDays = toNum(attendance.lopDays);
    const overtimeHours = toNum(attendance.overtimeHours);
    if (calendarDays) inputs.calendarDays = calendarDays;
    if (payableDays) inputs.payableDays = payableDays;
    if (lopDays) inputs.lopDays = lopDays;
    if (overtimeHours) inputs.otHours = overtimeHours;
  }

  // ── period (engine + compliance module both key off this) ──
  const periodArg = {
    start: isoDate(period.start),
    end: isoDate(period.end),
    payDate: isoDate(period.payDate),
    paymentDate: isoDate(period.payDate), // NZ module keys ACC/rates off payment date
    frequency: period.frequency || null,
    fiscalYear: period.taxYear || null,
  };

  // ── employee statutory context (flags only; never raw identity numbers) ──
  const sp = statutory || {};
  const employeeArg = {
    gender: employee.gender || null,
    dateOfBirth: isoDate(employee.dateOfBirth),
    // India
    hasPan: sp.pan ? true : sp.pan === null && sp.countryCode === 'IN' ? false : undefined,
    // New Zealand
    taxCode: sp.taxCode || undefined,
    kiwiSaver: buildKiwiSaverContext(sp),
    studentLoan: buildStudentLoanContext(sp),
  };
  // Only assert hasPan=false for India profiles that genuinely lack a PAN.
  if (entity.countryCode === 'IN') {
    employeeArg.hasPan = !!sp.pan;
  } else {
    delete employeeArg.hasPan;
  }

  // ── entity / establishment statutory policy ──
  const entityArg = {
    countryCode: entity.countryCode,
    stateCode: sp.ptStateCode || employee.stateCode || entity.stateCode || undefined,
    pfApplicable: sp.uan != null || sp.pfMemberId != null ? true : entity.countryCode === 'IN',
    esiApplicable: sp.esiApplicable === true,
    pfOnFullWage: sp.pfOptIn === true,
    establishmentHasContributoryMember: true,
    paymentDate: isoDate(period.payDate),
  };

  const engineArgs = {
    components: componentsForEngine,
    inputs,
    complianceModule: resolveModule(entity.countryCode, periodArg.end),
    ytd: ytd || {},
    period: periodArg,
    employee: employeeArg,
    entity: entityArg,
    currencyCode: entity.payCurrency || undefined,
  };

  const meta = {
    employeeId: employee.id,
    compensationId: compensation.id,
    payableDays: attendance ? toNum(attendance.payableDays) : 0,
    lopDays: attendance ? toNum(attendance.lopDays) : 0,
    overtimeHours: attendance ? toNum(attendance.overtimeHours) : 0,
  };

  return { componentsForEngine, engineArgs, meta };
}

/** Build the NZ kiwiSaver employee context from a StatutoryProfile. */
function buildKiwiSaverContext(sp) {
  if (!sp || sp.countryCode !== 'NZ') return undefined;
  const statusMap = {
    NOT_ENROLLED: 'NOT_MEMBER',
    ACTIVE: 'ACTIVE',
    OPTED_OUT: 'OPTED_OUT',
    SAVINGS_SUSPENSION: 'SUSPENDED',
    CASUAL_AGRICULTURAL: 'ACTIVE',
  };
  const ctx = {};
  if (sp.kiwiSaverStatus) ctx.status = statusMap[sp.kiwiSaverStatus] || 'ACTIVE';
  if (sp.kiwiSaverEmployeeRate != null) ctx.employeeRate = toNum(sp.kiwiSaverEmployeeRate);
  if (sp.esctRate != null) ctx.esctRateForYear = toNum(sp.esctRate);
  return Object.keys(ctx).length ? ctx : undefined;
}

/** Build the NZ studentLoan extra-deduction context from a StatutoryProfile. */
function buildStudentLoanContext(sp) {
  if (!sp || sp.countryCode !== 'NZ') return undefined;
  if (sp.studentLoanExtraDeduction == null) return undefined;
  return { slborPerPeriodMinor: decimalToMinor(sp.studentLoanExtraDeduction) };
}

/** Resolve the compliance module for a country as-of a date (registry seam). */
function resolveModule(countryCode, asOf) {
  return registry.resolveComplianceModule(countryCode, asOf);
}

// ===========================================================================
//  ORCHESTRATION (DB-touching) — implements the API contract
// ===========================================================================

function notFound(message) {
  const e = new PayRunError('NOT_FOUND', message);
  e.statusCode = 404;
  return e;
}
function badRequest(code, message) {
  const e = new PayRunError(code, message);
  e.statusCode = 400;
  return e;
}

/** Run code, e.g. PR-2026-04-IN. */
function buildRunCode(entity, periodStart) {
  const ym = isoDate(periodStart).slice(0, 7); // YYYY-MM
  return `PR-${ym}-${entity.countryCode}`;
}

/** Payslip code, e.g. PS-2026-04-EMP-000142. */
function buildPayslipCode(periodStart, employeeCode) {
  const ym = isoDate(periodStart).slice(0, 7);
  return `PS-${ym}-${employeeCode}`;
}

/** Tax year string from a period end + entity fiscal start month (Apr). */
function taxYearFor(periodEnd, startMonth = 4) {
  const d = new Date(isoDate(periodEnd) + 'T00:00:00Z');
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const startY = m >= startMonth ? y : y - 1;
  const endY = (startY + 1) % 100;
  return `${startY}-${String(endY).padStart(2, '0')}`;
}

/**
 * createRun — insert a PayRun (DRAFT) with the exactly-once guard.
 * Exactly-once: (businessId, code) is unique; a duplicate create returns the
 * existing run rather than a second row (idempotent on the period).
 */
async function createRun({ businessId, actorId, entityId, payCalendarId, periodStart, periodEnd }) {
  if (!entityId || !payCalendarId || !periodStart || !periodEnd) {
    throw badRequest('MISSING_FIELDS', 'entityId, payCalendarId, periodStart and periodEnd are required');
  }
  const entity = await prisma.entity.findFirst({
    where: { id: entityId, businessId, deletedAt: null },
  });
  if (!entity) throw notFound('Entity not found');

  const cal = await prisma.payCalendar.findFirst({
    where: { id: payCalendarId, businessId, entityId },
  });
  if (!cal) throw notFound('Pay calendar not found for this entity');

  const code = buildRunCode(entity, periodStart);
  const payDate = derivePayDate(cal, periodEnd);
  const taxYear = taxYearFor(periodEnd, entity.taxYearStartMonth || 4);

  // Exactly-once guard: if a run already exists for (businessId, code), return it.
  const existing = await prisma.payRun.findFirst({ where: { businessId, code } });
  if (existing) return existing;

  try {
    return await prisma.payRun.create({
      data: {
        businessId,
        entityId,
        payCalendarId,
        code,
        periodStart: new Date(isoDate(periodStart)),
        periodEnd: new Date(isoDate(periodEnd)),
        payDate: new Date(isoDate(payDate)),
        sequenceInYear: sequenceFor(periodStart, entity.taxYearStartMonth || 4, cal.frequency),
        taxYear,
        currencyCode: entity.payCurrency,
        status: 'DRAFT',
        notes: actorId ? `Created by ${actorId}` : null,
      },
    });
  } catch (e) {
    if (e.code === 'P2002') {
      // Lost the race — return the row the winner created.
      const won = await prisma.payRun.findFirst({ where: { businessId, code } });
      if (won) return won;
    }
    throw e;
  }
}

/** Derive a pay date from the calendar rule (best-effort; defaults to period end). */
function derivePayDate(cal, periodEnd) {
  const end = new Date(isoDate(periodEnd) + 'T00:00:00Z');
  if (cal && cal.payDayRule === 'FIXED_DAY_OF_MONTH' && cal.payDayValue) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), cal.payDayValue));
    if (d >= end) return isoDate(d);
    // next month
    return isoDate(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, cal.payDayValue)));
  }
  return isoDate(end);
}

/** sequenceInYear 1..12 (monthly) / 1..26 (fortnightly) from the period start. */
function sequenceFor(periodStart, startMonth, frequency) {
  const d = new Date(isoDate(periodStart) + 'T00:00:00Z');
  const m = d.getUTCMonth() + 1;
  const monthsSinceStart = ((m - startMonth + 12) % 12) + 1;
  if (frequency === 'FORTNIGHTLY') return Math.min(26, monthsSinceStart * 2);
  if (frequency === 'WEEKLY') return Math.min(52, monthsSinceStart * 4);
  return monthsSinceStart;
}

/**
 * loadEmployeesForRun — gather the active employees of the run's entity and,
 * for each, the row bundle the PURE mapping needs. DB-touching; the mapping
 * itself stays pure.
 */
async function loadRunRowBundles(businessId, payRun) {
  const entity = await prisma.entity.findFirst({
    where: { id: payRun.entityId, businessId },
  });
  if (!entity) throw notFound('Entity not found');

  const periodEnd = isoDate(payRun.periodEnd);

  // Active employees with a CURRENT employment record in this entity.
  const employments = await prisma.employmentRecord.findMany({
    where: { businessId, entityId: payRun.entityId, isCurrent: true },
    select: { employeeId: true },
  });
  const employeeIds = [...new Set(employments.map((e) => e.employeeId))];
  if (employeeIds.length === 0) return { entity, bundles: [] };

  const employees = await prisma.employee.findMany({
    where: { id: { in: employeeIds }, businessId, isActive: true, deletedAt: null },
    include: { statutoryProfile: true },
  });

  // Frozen attendance inputs for this run, indexed by employee.
  const attendanceRows = await prisma.attendancePayInput.findMany({
    where: { businessId, payRunId: payRun.id },
  });
  const attendanceByEmp = new Map(attendanceRows.map((a) => [a.employeeId, a]));

  const bundles = [];
  for (const emp of employees) {
    // Resolve the current compensation revision effective on the period end.
    const compensation = await resolveCurrentCompensation(businessId, emp.id, periodEnd);
    if (!compensation) continue; // no pay structure -> skip (not an error)

    bundles.push({
      employee: emp,
      compensation,
      statutory: emp.statutoryProfile || null,
      attendance: attendanceByEmp.get(emp.id) || null,
      entity,
      period: {
        start: isoDate(payRun.periodStart),
        end: periodEnd,
        payDate: isoDate(payRun.payDate),
        frequency: null, // filled below from calendar if needed
        taxYear: payRun.taxYear,
      },
      ytd: null,
    });
  }

  // Attach the pay frequency (from the calendar) to every bundle's period.
  const cal = await prisma.payCalendar.findFirst({ where: { id: payRun.payCalendarId, businessId } });
  const frequency = cal ? cal.frequency : null;
  for (const b of bundles) b.period.frequency = frequency;

  return { entity, bundles };
}

/** Resolve the CompensationRevision effective on `asOf`, with its lines + components. */
async function resolveCurrentCompensation(businessId, employeeId, asOf) {
  const asOfDate = new Date(isoDate(asOf) + 'T00:00:00Z');
  // Prefer the revision whose [effectiveFrom, effectiveTo] window covers asOf.
  const covering = await prisma.compensationRevision.findFirst({
    where: {
      businessId,
      employeeId,
      effectiveFrom: { lte: asOfDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOfDate } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    include: { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } },
  });
  if (covering) return covering;
  // Fallback: the current revision (isCurrent) even if effectiveTo already closed.
  return prisma.compensationRevision.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    orderBy: { effectiveFrom: 'desc' },
    include: { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } },
  });
}

/**
 * computeRun — gather inputs, run the engine per employee, persist lines +
 * payslips, transition DRAFT -> INPUTS_LOCKED -> CALCULATED in one transaction.
 * Idempotent: re-running with the same inputHash is a no-op.
 */
async function computeRun({ businessId, actorId, payRunId }) {
  const payRun = await prisma.payRun.findFirst({ where: { id: payRunId, businessId } });
  if (!payRun) throw notFound('Pay run not found');

  // Already-computed runs: idempotent no-op unless re-opened to DRAFT.
  if (['COMPUTED', 'APPROVED', 'PAID', 'FILED'].includes(payRun.status)) {
    // Return the existing computed detail.
    return getRun({ businessId, payRunId });
  }
  if (payRun.status !== 'DRAFT' && payRun.status !== 'INPUTS_LOCKED') {
    throw badRequest('BAD_STATE', `Cannot compute a run in ${payRun.status}`);
  }

  const { entity, bundles } = await loadRunRowBundles(businessId, payRun);

  // Map + compute each employee (PURE per employee).
  const lines = [];
  const anomalies = [];
  let blockingCount = 0;
  for (const bundle of bundles) {
    const { engineArgs, meta } = buildEmployeePayInput(bundle);
    const result = computePayslip(engineArgs);
    for (const a of result.anomalies || []) {
      anomalies.push({ employeeId: meta.employeeId, ...a });
      if (a.severity === 'BLOCKER' || a.severity === 'BLOCK') blockingCount += 1;
    }
    lines.push({
      employeeId: meta.employeeId,
      compensationId: meta.compensationId,
      payableDays: meta.payableDays,
      lopDays: meta.lopDays,
      overtimeHours: meta.overtimeHours,
      employeeCode: bundle.employee.code,
      result,
    });
  }

  // Content-address the frozen inputs for idempotency (§11.1).
  const inputHash = computeInputHash({
    inputs: lines.map((l) => ({
      employeeId: l.employeeId,
      compensationId: l.compensationId,
      payableDays: l.payableDays,
      lopDays: l.lopDays,
      overtimeHours: l.overtimeHours,
      grossMinor: l.result.grossMinor,
      netMinor: l.result.netMinor,
    })),
    ruleVersions: { country: entity.countryCode },
    engineVersion: ENGINE_VERSION,
  });

  // Idempotency: same inputHash already computed -> no-op.
  if (payRun.status === 'COMPUTED' && payRun.complianceVersionId === inputHash) {
    return getRun({ businessId, payRunId });
  }

  // ── Transition DRAFT -> INPUTS_LOCKED -> CALCULATED in one transaction. ──
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // Pure state-machine guard (DRAFT -> INPUTS_LOCKED requires inputHash).
    let runState = { id: payRun.id, status: STATE.DRAFT, preparerId: payRun.lockedBy || actorId };
    if (payRun.status === 'INPUTS_LOCKED') runState.status = STATE.INPUTS_LOCKED;
    if (runState.status === STATE.DRAFT) {
      runState = transition(runState, STATE.INPUTS_LOCKED, { inputHash, actorId, at: now });
    } else {
      runState.inputHash = inputHash;
    }
    runState = transition(runState, STATE.CALCULATED, { inputHash, actorId, at: now });

    // Persist the locked/computed status + the inputHash (as complianceVersionId).
    await tx.payRun.update({
      where: { id: payRun.id },
      data: {
        status: 'COMPUTED',
        lockedAt: payRun.lockedAt || now,
        lockedBy: payRun.lockedBy || actorId || null,
        computedAt: now,
        computedBy: actorId || null,
        complianceVersionId: inputHash,
        version: { increment: 1 },
      },
    });

    // Clear prior compute artefacts for this run (recompute is idempotent).
    await tx.payslip.deleteMany({ where: { businessId, payRunId: payRun.id } });
    await tx.payRunLineComponent.deleteMany({ where: { payRunLine: { payRunId: payRun.id } } });
    await tx.payRunLine.deleteMany({ where: { payRunId: payRun.id } });

    let totGross = 0, totDed = 0, totNet = 0, totEr = 0;
    for (const ln of lines) {
      const r = ln.result;
      const lineRow = await tx.payRunLine.create({
        data: {
          businessId,
          payRunId: payRun.id,
          employeeId: ln.employeeId,
          compensationId: ln.compensationId,
          payableDays: ln.payableDays || 0,
          lopDays: ln.lopDays || 0,
          overtimeHours: ln.overtimeHours || 0,
          grossEarnings: toDec(r.grossMinor),
          totalDeductions: toDec(r.totalEmployeeDeductionsMinor),
          netPay: toDec(r.netMinor),
          employerCost: toDec(r.totalEmployerContributionsMinor),
          currencyCode: payRun.currencyCode,
          status: 'COMPUTED',
          computeTrace: r.explain || null,
          errorJson: (r.anomalies && r.anomalies.length) ? r.anomalies : undefined,
          ...statutoryRollups(r),
        },
      });

      const comps = buildComponentRows(businessId, lineRow.id, r);
      if (comps.length) await tx.payRunLineComponent.createMany({ data: comps });

      // Payslip (frozen snapshot).
      await tx.payslip.create({
        data: {
          businessId,
          payRunId: payRun.id,
          payRunLineId: lineRow.id,
          employeeId: ln.employeeId,
          code: buildPayslipCode(payRun.periodStart, ln.employeeCode || ln.employeeId),
          periodStart: payRun.periodStart,
          periodEnd: payRun.periodEnd,
          payDate: payRun.payDate,
          currencyCode: payRun.currencyCode,
          grossEarnings: toDec(r.grossMinor),
          totalDeductions: toDec(r.totalEmployeeDeductionsMinor),
          netPay: toDec(r.netMinor),
          snapshotJson: buildPayslipSnapshot(r, payRun, ln),
          status: 'GENERATED',
        },
      });

      totGross += r.grossMinor;
      totDed += r.totalEmployeeDeductionsMinor;
      totNet += r.netMinor;
      totEr += r.totalEmployerContributionsMinor;
    }

    await tx.payRun.update({
      where: { id: payRun.id },
      data: {
        headcount: lines.length,
        totalGross: toDec(totGross),
        totalDeductions: toDec(totDed),
        totalNet: toDec(totNet),
        totalEmployerCost: toDec(totEr),
      },
    });
  });

  const detail = await getRun({ businessId, payRunId });
  detail.anomalies = anomalies;
  detail.blockingAnomalies = blockingCount;
  return detail;
}

/** Minor units -> Decimal string "x.xx" (scale 2). No float. */
function toDec(minor) {
  return money.fromMinor(minor, 2);
}

/** Map known statutory codes to PayRunLine rollup columns (Decimal). */
function statutoryRollups(r) {
  const byCode = {};
  for (const d of r.employeeDeductions || []) byCode[d.code] = d.amountMinor;
  for (const c of r.employerContributions || []) byCode[c.code] = c.amountMinor;
  const pick = (...codes) => {
    for (const c of codes) if (byCode[c] != null) return toDec(byCode[c]);
    return null;
  };
  return {
    pfEmployee: pick('EPF', 'EPF_EE'),
    pfEmployer: pick('EPF_ER'),
    esiEmployee: pick('ESI', 'ESI_EE'),
    esiEmployer: pick('ESI_ER'),
    pt: pick('PT'),
    tds: pick('TDS'),
    paye: pick('PAYE'),
    kiwiSaverEmployee: pick('KIWISAVER', 'KIWISAVER_EE'),
    kiwiSaverEmployer: pick('KIWISAVER_ER'),
    esct: pick('ESCT'),
    accLevy: pick('ACC'),
    studentLoan: pick('SLOAN', 'STUDENT_LOAN'),
  };
}

function buildComponentRows(businessId, payRunLineId, r) {
  const rows = [];
  let sort = 0;
  for (const e of r.earnings || []) rows.push(compRow(businessId, payRunLineId, e, 'EARNING', false, sort++));
  for (const d of r.employeeDeductions || []) rows.push(compRow(businessId, payRunLineId, d, 'DEDUCTION', !!d.statutory, sort++));
  for (const c of r.employerContributions || []) rows.push(compRow(businessId, payRunLineId, c, 'EMPLOYER_COST', true, sort++));
  for (const rb of r.reimbursements || []) rows.push(compRow(businessId, payRunLineId, rb, 'REIMBURSEMENT', false, sort++));
  return rows;
}

function compRow(businessId, payRunLineId, item, category, isStatutory, sortOrder) {
  return {
    businessId,
    payRunLineId,
    componentId: item.componentId || item.code,
    componentCode: item.code,
    componentName: item.label || item.code,
    category,
    amount: toDec(item.amountMinor),
    baseAmount: item.baseMinor != null ? toDec(item.baseMinor) : null,
    isStatutory,
    sortOrder,
  };
}

/** Build the frozen payslip snapshot JSON (major-unit strings for display). */
function buildPayslipSnapshot(r, payRun, ln) {
  const toMajor = (m) => money.fromMinor(m, 2);
  return {
    currencyCode: payRun.currencyCode,
    periodStart: isoDate(payRun.periodStart),
    periodEnd: isoDate(payRun.periodEnd),
    payDate: isoDate(payRun.payDate),
    earnings: (r.earnings || []).map((e) => ({ code: e.code, label: e.label, amount: toMajor(e.amountMinor) })),
    employeeDeductions: (r.employeeDeductions || []).map((d) => ({ code: d.code, label: d.label, amount: toMajor(d.amountMinor), statutory: !!d.statutory })),
    employerContributions: (r.employerContributions || []).map((c) => ({ code: c.code, label: c.label, amount: toMajor(c.amountMinor) })),
    reimbursements: (r.reimbursements || []).map((rb) => ({ code: rb.code, label: rb.label, amount: toMajor(rb.amountMinor) })),
    gross: toMajor(r.grossMinor),
    totalDeductions: toMajor(r.totalEmployeeDeductionsMinor),
    totalEmployerCost: toMajor(r.totalEmployerContributionsMinor),
    net: toMajor(r.netMinor),
    bases: r.bases || null,
    anomalies: r.anomalies || [],
  };
}

/**
 * approveRun — maker-checker. Approver must differ from the preparer/computer.
 * Transitions COMPUTED -> APPROVED. Blocking anomalies gate approval.
 */
async function approveRun({ businessId, actorId, payRunId, fourEyes = true }) {
  const payRun = await prisma.payRun.findFirst({ where: { id: payRunId, businessId } });
  if (!payRun) throw notFound('Pay run not found');

  // Re-evaluate blocking anomalies from persisted line errors.
  const linesWithErrors = await prisma.payRunLine.findMany({
    where: { businessId, payRunId, errorJson: { not: null } },
    select: { errorJson: true },
  });
  let blockingAnomalies = 0;
  for (const l of linesWithErrors) {
    const errs = Array.isArray(l.errorJson) ? l.errorJson : [];
    for (const e of errs) if (e.severity === 'BLOCKER') blockingAnomalies += 1;
  }

  // Pure state-machine guard (NOT_CALCULATED, MAKER_CHECKER, OPEN_BLOCKERS).
  const runState = {
    id: payRun.id,
    status: STATE.CALCULATED, // schema COMPUTED maps to engine CALCULATED
    preparerId: payRun.computedBy || payRun.lockedBy,
    blockingAnomalies,
    fourEyes,
  };
  if (payRun.status !== 'COMPUTED') {
    throw badRequest('NOT_CALCULATED', `Approval requires a COMPUTED run (current: ${payRun.status})`);
  }
  transition(runState, STATE.APPROVED, { actorId, at: new Date(), blockingAnomalies, fourEyes });

  const res = await prisma.payRun.updateMany({
    where: { id: payRunId, businessId, status: 'COMPUTED' },
    data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: actorId || null, version: { increment: 1 } },
  });
  if (res.count === 0) throw badRequest('STALE_TRANSITION', 'Pay run is no longer in COMPUTED state');

  return getRun({ businessId, payRunId });
}

/** listRuns — paginated list, tenant-scoped. */
async function listRuns({ businessId, entityId, status, page = 1, pageSize = 25 }) {
  const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const where = { businessId, deletedAt: null };
  if (entityId) where.entityId = entityId;
  if (status) where.status = status;
  const [items, total] = await Promise.all([
    prisma.payRun.findMany({ where, orderBy: { periodStart: 'desc' }, skip, take }),
    prisma.payRun.count({ where }),
  ]);
  return { items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take };
}

/** getRun — run detail + lines + totals + anomalies. */
async function getRun({ businessId, payRunId }) {
  const payRun = await prisma.payRun.findFirst({
    where: { id: payRunId, businessId, deletedAt: null },
    include: {
      entity: { select: { id: true, code: true, legalName: true, countryCode: true, payCurrency: true } },
      lines: {
        orderBy: { createdAt: 'asc' },
        include: {
          employee: { select: { id: true, code: true, firstName: true, lastName: true } },
          components: { orderBy: { sortOrder: 'asc' } },
        },
      },
    },
  });
  if (!payRun) throw notFound('Pay run not found');

  const anomalies = [];
  for (const l of payRun.lines) {
    const errs = Array.isArray(l.errorJson) ? l.errorJson : [];
    for (const e of errs) anomalies.push({ employeeId: l.employeeId, ...e });
  }

  return {
    payRun,
    lines: payRun.lines,
    totals: {
      headcount: payRun.headcount,
      totalGross: payRun.totalGross,
      totalDeductions: payRun.totalDeductions,
      totalNet: payRun.totalNet,
      totalEmployerCost: payRun.totalEmployerCost,
    },
    anomalies,
  };
}

/** getRunPayslips — payslips for the run. */
async function getRunPayslips({ businessId, payRunId }) {
  const payRun = await prisma.payRun.findFirst({ where: { id: payRunId, businessId } });
  if (!payRun) throw notFound('Pay run not found');
  const items = await prisma.payslip.findMany({
    where: { businessId, payRunId, deletedAt: null },
    include: { employee: { select: { id: true, code: true, firstName: true, lastName: true } } },
    orderBy: { code: 'asc' },
  });
  return { items, total: items.length };
}

/** getPayslip — one payslip (full breakdown), operator view. */
async function getPayslip({ businessId, payslipId }) {
  const payslip = await prisma.payslip.findFirst({
    where: { id: payslipId, businessId, deletedAt: null },
    include: {
      employee: { select: { id: true, code: true, firstName: true, lastName: true } },
      payRunLine: { include: { components: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!payslip) throw notFound('Payslip not found');
  return payslip;
}

/** Resolve the Employee row that belongs to a logged-in customer (ESS user). */
async function resolveSelfEmployee(businessId, customer) {
  // Customer's portal identity links to Employee via Employee.userId === user.id,
  // or by matching workEmail/personalEmail to the customer email.
  const byEmail = customer.email
    ? await prisma.employee.findFirst({
        where: {
          businessId,
          deletedAt: null,
          OR: [{ workEmail: customer.email }, { personalEmail: customer.email }],
        },
        select: { id: true },
      })
    : null;
  if (byEmail) return byEmail.id;
  // Fallback: linked via User -> Employee.userId.
  const byUser = await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, user: { is: { email: customer.email } } },
    select: { id: true },
  });
  return byUser ? byUser.id : null;
}

/** getMyPayslips — the logged-in EMPLOYEE's own payslips (ESS). */
async function getMyPayslips({ businessId, customer }) {
  const employeeId = await resolveSelfEmployee(businessId, customer);
  if (!employeeId) return { items: [], total: 0 };
  const items = await prisma.payslip.findMany({
    where: { businessId, employeeId, deletedAt: null, status: { in: ['PUBLISHED', 'VIEWED'] } },
    orderBy: { payDate: 'desc' },
    select: {
      id: true, code: true, periodStart: true, periodEnd: true, payDate: true,
      currencyCode: true, grossEarnings: true, totalDeductions: true, netPay: true, status: true,
    },
  });
  return { items, total: items.length };
}

/** getMyPayslip — the logged-in employee's own payslip detail (ESS). */
async function getMyPayslip({ businessId, customer, payslipId }) {
  const employeeId = await resolveSelfEmployee(businessId, customer);
  if (!employeeId) throw notFound('Payslip not found');
  const payslip = await prisma.payslip.findFirst({
    where: { id: payslipId, businessId, employeeId, deletedAt: null, status: { in: ['PUBLISHED', 'VIEWED'] } },
  });
  if (!payslip) throw notFound('Payslip not found');
  // Mark first view.
  if (payslip.status === 'PUBLISHED') {
    await prisma.payslip.update({ where: { id: payslip.id }, data: { status: 'VIEWED', viewedAt: new Date() } });
  }
  return payslip;
}

// ===========================================================================
//  FILE GENERATION — delegate to filing/india.js | filing/newzealand.js
// ===========================================================================

const FILE_KINDS = Object.freeze({
  ecr: { country: 'IN', fn: 'generateEcr' },
  esic: { country: 'IN', fn: 'generateEsic' },
  form24q: { country: 'IN', fn: 'generate24Q' },
  ei: { country: 'NZ', fn: 'generateEmploymentInformation' },
  bank: { country: 'NZ', fn: 'generateBankBatch' },
});

/**
 * generateFile — build a statutory/bank file for a run by delegating to the
 * pure filing generators with a pay-run AGGREGATE assembled from persisted rows.
 */
async function generateFile({ businessId, payRunId, kind }) {
  const spec = FILE_KINDS[String(kind || '').toLowerCase()];
  if (!spec) throw badRequest('UNKNOWN_FILE_KIND', `Unknown file kind "${kind}"`);

  const payRun = await prisma.payRun.findFirst({
    where: { id: payRunId, businessId, deletedAt: null },
    include: { entity: true },
  });
  if (!payRun) throw notFound('Pay run not found');
  if (payRun.entity.countryCode !== spec.country) {
    throw badRequest('COUNTRY_MISMATCH', `File "${kind}" is a ${spec.country} filing; run entity is ${payRun.entity.countryCode}`);
  }

  const lines = await prisma.payRunLine.findMany({
    where: { businessId, payRunId },
    include: {
      employee: { select: { code: true, firstName: true, lastName: true, statutoryProfile: true } },
    },
  });

  const aggregate = buildFilingAggregate(payRun, lines, spec.country);
  const gen = filing[spec.country === 'IN' ? 'india' : 'newzealand'][spec.fn];
  return gen(aggregate);
}

/** Assemble the pure filing aggregate (integer minor units) from persisted rows. */
function buildFilingAggregate(payRun, lines, country) {
  const period = isoDate(payRun.periodStart).slice(0, 7); // YYYY-MM
  const empName = (e) => [e.firstName, e.lastName].filter(Boolean).join(' ');

  if (country === 'IN') {
    return {
      period,
      financialYear: payRun.taxYear,
      quarter: indianQuarter(payRun.periodEnd),
      establishment: {
        pfEstablishmentCode: payRun.entity.pan || null,
        esicCode: payRun.entity.gstin || null,
      },
      entity: { tan: payRun.entity.tan || '', name: payRun.entity.legalName },
      lines: lines.map((l) => {
        const sp = (l.employee && l.employee.statutoryProfile) || {};
        return {
          employee: { uan: sp.uan || '', name: empName(l.employee), esicIp: sp.esicIp || '', pan: sp.pan || '', code: l.employee.code },
          grossWagesMinor: decimalToMinor(l.grossEarnings),
          epfWagesMinor: decimalToMinor(l.pfEmployee) ? Math.round(decimalToMinor(l.pfEmployee) / 0.12) : 0,
          epsWagesMinor: 0,
          edliWagesMinor: 0,
          epfEeMinor: decimalToMinor(l.pfEmployee),
          epfErMinor: decimalToMinor(l.pfEmployer),
          epsMinor: 0,
          ncpDays: Math.round(Number(l.lopDays) || 0),
          refundAdvanceMinor: 0,
          esiGrossMinor: decimalToMinor(l.esiEmployee) || decimalToMinor(l.esiEmployer) ? decimalToMinor(l.grossEarnings) : 0,
          esiEeMinor: decimalToMinor(l.esiEmployee),
          esiErMinor: decimalToMinor(l.esiEmployer),
          esiCovered: decimalToMinor(l.esiEmployer) > 0,
          tdsMinor: decimalToMinor(l.tds),
          taxableMinor: decimalToMinor(l.grossEarnings),
          workedDays: Math.round(Number(l.payableDays) || 0),
        };
      }),
    };
  }

  // New Zealand aggregate.
  return {
    periodStart: isoDate(payRun.periodStart),
    periodEnd: isoDate(payRun.periodEnd),
    paydayDate: isoDate(payRun.payDate),
    employer: {
      irdNumber: payRun.entity.irdEntityNumber || '',
      name: payRun.entity.legalName,
      shortName: payRun.entity.code,
    },
    lines: lines.map((l) => {
      const sp = (l.employee && l.employee.statutoryProfile) || {};
      return {
        employee: {
          name: empName(l.employee),
          irdNumber: sp.irdNumber || '',
          taxCode: sp.taxCode || '',
          bankAccount: null,
        },
        grossMinor: decimalToMinor(l.grossEarnings),
        notLiableAccMinor: 0,
        payeMinor: decimalToMinor(l.paye),
        esctMinor: decimalToMinor(l.esct),
        ksEmployeeMinor: decimalToMinor(l.kiwiSaverEmployee),
        ksEmployerGrossMinor: decimalToMinor(l.kiwiSaverEmployer),
        studentLoanMinor: decimalToMinor(l.studentLoan),
        studentLoanExtraMinor: 0,
        childSupportMinor: 0,
        donationsMinor: 0,
        netPayMinor: decimalToMinor(l.netPay),
      };
    }),
  };
}

function indianQuarter(periodEnd) {
  const m = new Date(isoDate(periodEnd) + 'T00:00:00Z').getUTCMonth() + 1;
  if (m >= 4 && m <= 6) return 'Q1';
  if (m >= 7 && m <= 9) return 'Q2';
  if (m >= 10 && m <= 12) return 'Q3';
  return 'Q4';
}

module.exports = {
  // PURE mapping (unit-testable without a DB)
  buildEmployeePayInput,
  mapComponentLine,
  decimalToMinor,
  PRORATION_MAP,
  CALC_MAP,
  resolveModule,
  // orchestration
  createRun,
  computeRun,
  approveRun,
  listRuns,
  getRun,
  getRunPayslips,
  getPayslip,
  getMyPayslips,
  getMyPayslip,
  generateFile,
  // internals exposed for tests
  _internal: { taxYearFor, buildFilingAggregate, statutoryRollups, buildPayslipSnapshot, resolveCurrentCompensation },
};
