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
const { writeAudit } = require('../../core/lib/audit');
const money = require('./money');
const engine = require('./engine');
const payrun = require('./payrun');
const variance = require('./variance');
const registry = require('./complianceRegistry');
const filing = require('./filing');
// Cycle-0 wiring: loan/advance recovery in the pay run. The loans module owns the
// installment selection + Loan running-total bookkeeping (controllers/loanRecovery.js)
// so payroll never forks the loan math; the engine owns the net-floor cap.
const loanRecovery = require('../controllers/loanRecovery');
// SHARED-FILE EDIT (Feature 26 — FLAGGED): reimbursement paid via payroll. MIRRORS
// loanRecovery but as a POSITIVE payment — the expense module owns the ExpenseClaim
// bookkeeping (controllers/reimbursementPayout.js) so payroll never forks the claim
// math; the engine's existing CATEGORY.REIMBURSEMENT seam adds the line to net AFTER
// statutory deductions (no engine fork). Wired at the SAME three points loan recovery
// uses (loadRunRowBundles / buildEmployeePayInput / persistComputedRun + reopen/cancel).
const reimbursementPayout = require('../controllers/reimbursementPayout');
// Feature 14: a payroll run's entity country MUST equal the tenant country. The
// engine still routes by the entity's countryCode (the correct per-run design);
// this is a fail-closed TRIPWIRE at the run boundary so a quarantined / bad
// -backfill tenant can never compute payroll for the wrong market.
const { assertCountry } = require('../tenant/countryContext');

// Publish chain (Feature 7): payslip.published webhook + HR_PAYSLIP_PUBLISHED
// notification. Both are pre-wired libraries (not routers) invoked from publishRun.
const webhooks = require('../integrations/webhooks');
const notifications = require('../integrations/notifications');

const india = require('./compliance/india');
const newzealand = require('./compliance/newzealand');
// Feature 23 — the SAME effective-dated kind resolver the compliance generator
// uses, so fileRun() and calendarRunner emit ONE row per period (no 24Q-vs-138
// duplicate). DEFAULT_SUCCESSOR carries the Income Tax Act 2025 boundaries.
const { resolveKindForPeriod, DEFAULT_SUCCESSOR } = require('./compliance/india.calendar');

// Attendance freeze bridge (Feature 2). Opt-in from computeRun so existing
// seed-driven pay runs (which pre-seed AttendancePayInput) are untouched.
const { freezeAttendance } = require('../attendance/freeze');

const { CATEGORY, CALC, PRORATION, LOP_BEHAVIOR, computePayslip } = engine;
const {
  STATE, PayRunError, transition, computeInputHash, persistTransition, PRISMA_TO_STATE,
} = payrun;

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
  // DB BALANCING (a special-allowance EARNING that fills to a target gross) maps
  // to the engine's BALANCING earning — NOT the deduction-side BALANCE_RECOVERY.
  BALANCING: CALC.BALANCING,
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
 *
 * `targetGrossMinor` is the period gross/CTC target the structure must reconcile
 * to; it is threaded onto BALANCING (special-allowance) earnings so the engine
 * can compute the residual. Falls back to the seeded line amount if absent.
 */
function mapComponentLine(line, order, targetGrossMinor = null, entityProrationBasis = null) {
  const comp = line.component || {};
  const calcMethod = line.calcMethod || comp.calcMethod;
  // Statutory + slab components are computed by the compliance module, not the
  // engine. Drop them so they don't double-count.
  if (calcMethod === 'STATUTORY' || calcMethod === 'SLAB') return null;

  const engineCalc = CALC_MAP[calcMethod];
  if (!engineCalc) return null;

  const category = comp.category || 'EARNING';
  // Feature 16 — proration policy precedence: the COMPONENT's own prorationMethod
  // wins (a statutory-floor allowance can pin NONE), else the ENTITY basis
  // (Entity.prorationBasis), else CALENDAR_DAYS. So a tenant on FIXED_30 prorates
  // every REDUCES_WITH_LOP earning over 30 days without per-component config.
  const resolvedProrationMethod = comp.prorationMethod || entityProrationBasis || 'CALENDAR_DAYS';
  const prorationPolicy = PRORATION_MAP[resolvedProrationMethod] || PRORATION.CALENDAR_DAYS;
  const lopBehavior =
    (resolvedProrationMethod === 'NONE' || comp.isRecurring === false)
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
  } else if (engineCalc === CALC.BALANCING) {
    // BALANCING earning fills the gap to the structure's period gross/CTC target.
    // Prefer the explicit target; fall back to the seeded line amount so a
    // structure without a target still yields a sensible (flat) value.
    const seeded = decimalToMinor(line.amountMonthly != null ? line.amountMonthly : line.calcValue);
    def.targetGrossMinor =
      targetGrossMinor != null && targetGrossMinor > 0 ? targetGrossMinor : seeded;
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
 * Resolve the per-period GROSS target a BALANCING earning fills to, in integer
 * minor units. Source precedence:
 *   1. compensation.grossMonthly — the structure's resolved monthly gross
 *      (this is the gross the package must reconcile to; for IN it already
 *      equals Σ Basic+HRA+Special at full attendance).
 *   2. compensation.ctcAnnual / 12 — weak fallback when grossMonthly is unset.
 *      (CTC includes employer cost, so this only approximates a gross target;
 *      the balancing line clamps at 0 if it would go negative.)
 * Returns 0 when neither is available (engine then uses the seeded flat amount).
 * PURE: no DB, no I/O.
 */
function resolveBalancingTarget(compensation, _period) {
  if (!compensation) return 0;
  if (compensation.grossMonthly != null && compensation.grossMonthly !== '') {
    return decimalToMinor(compensation.grossMonthly);
  }
  if (compensation.ctcAnnual != null && compensation.ctcAnnual !== '') {
    const annualMinor = decimalToMinor(compensation.ctcAnnual);
    // Monthly share of the annual figure (exact integer paise via roundRational).
    return money.roundRational(annualMinor, 12, money.RoundingMode.HALF_UP);
  }
  return 0;
}

// Feature 26 — net-floor sanity guard tuning. A reimbursement ADDS to net, so it can
// never push net negative on its own; this guard is a fail-CLOSED-with-review rail
// (the analogue of loan recovery's RECOVERY_CAPPED_TO_NET, but DEFER not silent-cap)
// against a payslip whose deductions already exceed earnings (heavy-LOP + loan month)
// or a mis-configured/fraudulent claim that dwarfs salary. Default 10× pre-reimbursement
// net; a deferred employee's WHOLE claim set carries untouched to the next run.
const REIMBURSEMENT_NET_RATIO_CAP = 10;

/**
 * evaluateReimbursementGuard(result) — the orchestrator net-floor sanity guard
 * (spec §6). Runs AFTER the engine result is in, on the engine's reported figures
 * (never forks engine math). Returns { defer, anomaly } where `defer` means "do NOT
 * pay the reimbursement this run — strip the line, leave the claims APPROVED, carry
 * them to the next run". `net_before_reimb = netMinor − reimbursementsMinor` (the
 * engine added the reimbursement to net unconditionally; we measure the pre-add net).
 *
 *   §6.1 Negative pre-reimbursement net → defer (the payslip is already broken; a big
 *        reimbursement would mask it). Anomaly REIMBURSEMENT_DEFERRED_NEGATIVE_NET.
 *   §6.2 Reimbursement-to-net ratio breach → defer for review. WARNING anomaly
 *        REIMBURSEMENT_EXCEEDS_NET_SANITY so a reviewer eyeballs it before approving.
 *   §6.3 Never partial-pay: the guard defers the WHOLE employee's reimbursement set.
 */
function evaluateReimbursementGuard(result) {
  const reimbMinor = result.reimbursementsMinor || 0;
  if (reimbMinor <= 0) return { defer: false, anomaly: null };
  const netBeforeReimb = (result.netMinor || 0) - reimbMinor;
  if (netBeforeReimb < 0) {
    return {
      defer: true,
      anomaly: {
        code: 'REIMBURSEMENT_DEFERRED_NEGATIVE_NET',
        severity: 'WARNING',
        message: `Reimbursement deferred: pre-reimbursement net is negative (${money.fromMinor(netBeforeReimb)}); deductions exceed earnings. The approved claim(s) stay APPROVED and ride the next run.`,
      },
    };
  }
  if (reimbMinor > REIMBURSEMENT_NET_RATIO_CAP * Math.max(netBeforeReimb, 0)) {
    return {
      defer: true,
      anomaly: {
        code: 'REIMBURSEMENT_EXCEEDS_NET_SANITY',
        severity: 'WARNING',
        message: `Reimbursement (${money.fromMinor(reimbMinor)}) exceeds ${REIMBURSEMENT_NET_RATIO_CAP}× net pay (${money.fromMinor(netBeforeReimb)}); deferred for review. Verify the claim amount, then re-run.`,
      },
    };
  }
  return { defer: false, anomaly: null };
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
  // The per-period gross target a BALANCING (special-allowance) earning must
  // reconcile to: the structure's monthly gross, else a CTC-derived monthly
  // figure (annual CTC / 12 — best-effort; the package is then balanced down to
  // it). All in integer minor units. 0/null means "no target" (engine falls back
  // to the seeded flat amount for the balancing line).
  const targetGrossMinor = resolveBalancingTarget(compensation, period);

  // Feature 16 — the entity's salary-proration basis (CALENDAR_DAYS default for
  // India). Every REDUCES_WITH_LOP earning inherits the ENTITY policy unless the
  // component itself pins a different prorationMethod (a statutory-floor allowance
  // may still override to NONE/FIXED_REGARDLESS). This makes the denominator a
  // tenant/entity decision, not an implicit per-component default.
  const entityProrationBasis = entity.prorationBasis || null;

  const compLines = Array.isArray(compensation.lines) ? compensation.lines : [];
  const componentsForEngine = [];
  let order = 0;
  for (const line of compLines) {
    const def = mapComponentLine(line, order, targetGrossMinor, entityProrationBasis);
    if (def) {
      componentsForEngine.push(def);
      order += 1;
    }
  }

  // Cycle-0 wiring — loan/advance recovery as a POST-TAX deduction that flows THROUGH
  // the engine (not bypassing it). A single LOAN_REPAYMENT line carries the Σ of the
  // installments due this period; CALC.BALANCE_RECOVERY makes the engine apply its
  // net-floor guard (caps to available net, emits RECOVERY_CAPPED_TO_NET) and report
  // the ACTUAL recovered figure in result.employeeDeductions — which persistComputedRun
  // reads back to stamp the installments. Not LOP-prorated (a fixed EMI is owed in full
  // regardless of attendance); the engine does not prorate voluntary deductions.
  const loanRec = rows.loanRecovery || null;
  if (loanRec && loanRec.totalDueMinor > 0) {
    componentsForEngine.push({
      code: 'LOAN_REPAYMENT',
      name: 'Loan / advance recovery',
      category: CATEGORY.DEDUCTION,
      calcMethod: CALC.BALANCE_RECOVERY,
      amountMinor: loanRec.totalDueMinor,
      showOnPayslip: true,
      _order: order,
      isTaxable: false,
      isPayeable: false,
    });
    order += 1;
  }

  // SHARED-FILE EDIT (Feature 26 — FLAGGED): reimbursement paid via payroll. The mirror
  // of the LOAN_REPAYMENT block above, but as a POSITIVE payment that flows THROUGH the
  // engine's existing CATEGORY.REIMBURSEMENT seam (engine.js §2/§7/§8): partitioned OUT
  // before statutory bases (NOT in pfWages/esiWages/ptWages/taxable/gratuity), evaluated
  // POST-tax, and ADDED to net AFTER all deductions. A single aggregated
  // EXPENSE_REIMBURSEMENT line carries Σ of the period's payable claims (the per-claim
  // breakdown lives on the claims, each stamped payRunId). Claim-bounded — the amount is
  // the approved claim total, never engine-fabricated; CALC.FIXED so the engine passes it
  // straight through (no proration, no cap — a reimbursement of an actual cost is owed in
  // full). persistComputedRun reads result.reimbursements back to stamp the claims.
  const reimb = rows.reimbursementPayout || null;
  if (reimb && reimb.totalPayableMinor > 0) {
    componentsForEngine.push({
      code: 'EXPENSE_REIMBURSEMENT',
      name: 'Expense reimbursement',
      category: CATEGORY.REIMBURSEMENT, // the existing engine seam (non-taxable, post-tax, add-to-net)
      calcMethod: CALC.FIXED,
      amountMinor: reimb.totalPayableMinor,
      showOnPayslip: true,
      _order: order,
      isTaxable: false, // belt-and-braces; REIMBURSEMENT is never in any statutory base anyway
      isPayeable: false,
    });
    order += 1;
  }

  // ── Inputs (proration / LOP / overtime) from the frozen AttendancePayInput ──
  // M1 — gate on `!= null` (presence), NOT truthiness. A frozen ZERO (e.g.
  // payableDays=0 for a fully-LOP month) is meaningful and MUST reach the engine;
  // `if (payableDays)` would silently drop it and the engine would fall back to a
  // full-period proration, overpaying the employee.
  const inputs = {};
  if (attendance) {
    if (attendance.calendarDays != null) inputs.calendarDays = toNum(attendance.calendarDays);
    if (attendance.payableDays != null) inputs.payableDays = toNum(attendance.payableDays);
    if (attendance.lopDays != null) inputs.lopDays = toNum(attendance.lopDays);
    if (attendance.overtimeHours != null) inputs.otHours = toNum(attendance.overtimeHours);
    // Feature 16 — the FROZEN proration denominator (entity prorationBasis applied
    // at freeze time). Setting it explicitly means the engine prorates over the
    // immutable, auditable standardDays rather than re-deriving the month length,
    // so a FIXED_30 / WORKING_DAYS basis is honoured and can't drift post-freeze.
    // Gate on `> 0` (a defaulted 0 = "use the engine's calendar fallback").
    if (attendance.standardDays != null && toNum(attendance.standardDays) > 0) {
      inputs.standardDays = toNum(attendance.standardDays);
    }
  }

  // ── period (engine + compliance module both key off this) ──
  const periodArg = {
    start: isoDate(period.start),
    end: isoDate(period.end),
    payDate: isoDate(period.payDate),
    paymentDate: isoDate(period.payDate), // NZ module keys ACC/rates off payment date
    frequency: period.frequency || null,
    fiscalYear: period.taxYear || null,
    // Feature 21 — PayRun type → compliance LWF once-per-period run-gate (passthrough;
    // null when untagged → the module fails open and treats the run as primary).
    runType: period.runType || null,
  };

  // ── employee statutory context (flags only; never raw identity numbers) ──
  const sp = statutory || {};
  const employeeArg = {
    gender: employee.gender || null,
    dateOfBirth: isoDate(employee.dateOfBirth),
    // India
    hasPan: sp.pan ? true : sp.pan === null && sp.countryCode === 'IN' ? false : undefined,
    // Feature 21 — LWF managerial/supervisory exclusion flag (null/false => covered;
    // fail-open to charging the flat welfare fee when the role is unknown).
    isManagerial: sp.isManagerial === true,
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
    // Feature 21 — LWF follows the PT/work-state precedence unless an explicit LWF
    // state override is set (the rare case the LWF jurisdiction ≠ the PT state).
    lwfStateCode: sp.lwfStateCode || undefined,
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

  // M2 — OT hours that no component will consume vanish silently. When otHours>0
  // but no ATTENDANCE_DRIVEN earning reads them (the paid path is unchanged), emit
  // a WARNING the run surfaces so the structure gap is visible.
  const preAnomalies = [];
  const otHours = toNum(inputs.otHours, 0);
  if (otHours > 0) {
    const consumes = componentsForEngine.some(
      (def) => def.calcMethod === CALC.ATTENDANCE_DRIVEN
        && (def.hoursField || 'otHours') === 'otHours',
    );
    if (!consumes) {
      preAnomalies.push({
        code: 'OT_HOURS_UNCONSUMED',
        severity: 'WARNING',
        message: `Frozen overtime of ${otHours}h is not consumed by any component (no FORMULA/overtime earning in the structure); the hours will not be paid.`,
      });
    }
  }

  const meta = {
    employeeId: employee.id,
    compensationId: compensation.id,
    payableDays: attendance ? toNum(attendance.payableDays) : 0,
    lopDays: attendance ? toNum(attendance.lopDays) : 0,
    // Feature 16 — LOP provenance (pure passthrough; persisted to PayRunLine +
    // surfaced on the payslip provenance block so an auditor sees WHY pay dropped).
    lwpDays: attendance ? toNum(attendance.lwpDays) : 0,
    absentDays: attendance ? toNum(attendance.absentDays) : 0,
    standardDays: attendance && toNum(attendance.standardDays) > 0
      ? toNum(attendance.standardDays)
      : (attendance ? toNum(attendance.calendarDays) : 0),
    overtimeHours: attendance ? toNum(attendance.overtimeHours) : 0,
    preAnomalies,
    // Cycle-0 — the installments this run will stamp once the engine reports how
    // much LOAN_REPAYMENT it actually recovered (after its net-floor cap).
    loanRecovery: loanRec || null,
    // Feature 26 (FLAGGED) — the claims this run will stamp REIMBURSED once the engine
    // reports the EXPENSE_REIMBURSEMENT it added to net. Net-floor sanity guard +
    // applyPayout run in persistComputedRun off result.reimbursements.
    reimbursementPayout: reimb || null,
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
  // Feature 14 tripwire — the run's entity must be the tenant country. Fail-closed:
  // a quarantined / mis-backfilled tenant cannot start a run for the wrong market.
  if (entity.countryCode) await assertCountry(businessId, entity.countryCode);

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
 * itself stays pure. Accepts an optional Prisma transaction client (`db`) so the
 * freeze + bundle-load + persist can share ONE transaction (M3).
 */
async function loadRunRowBundles(businessId, payRun, db = prisma) {
  const entity = await db.entity.findFirst({
    where: { id: payRun.entityId, businessId },
  });
  if (!entity) throw notFound('Entity not found');

  const periodEnd = isoDate(payRun.periodEnd);

  // SHARED-FILE EDIT (F18 #3 — flagged): a MIGRATED run pays an imported HISTORICAL
  // period, so it must scope by the EMPLOYMENT WINDOW (an employment record whose
  // [effectiveFrom, effectiveTo] overlaps periodStart..periodEnd), NOT the live
  // `isCurrent:true` + `isActive:true` filter. Otherwise a back-dated payslip for an
  // employee SINCE terminated (isActive=false) silently yields NO PayRunLine — the
  // imported worker loses their own historical payslip with no error. A LIVE run keeps
  // the unchanged current-active scoping. (Hard-deleted employees stay excluded.)
  const isMigrated = payRun.type === 'MIGRATED';
  const employments = isMigrated
    ? await db.employmentRecord.findMany({
      where: {
        businessId,
        entityId: payRun.entityId,
        effectiveFrom: { lte: payRun.periodEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: payRun.periodStart } }],
      },
      select: { employeeId: true },
    })
    : await db.employmentRecord.findMany({
      where: { businessId, entityId: payRun.entityId, isCurrent: true },
      select: { employeeId: true },
    });
  const employeeIds = [...new Set(employments.map((e) => e.employeeId))];
  if (employeeIds.length === 0) return { entity, bundles: [] };

  const employees = await db.employee.findMany({
    // MIGRATED runs do NOT require isActive (a since-terminated employee still owns
    // their historical payslip); LIVE runs keep the active-only filter.
    where: isMigrated
      ? { id: { in: employeeIds }, businessId, deletedAt: null }
      : { id: { in: employeeIds }, businessId, isActive: true, deletedAt: null },
    include: { statutoryProfile: true },
  });

  // Frozen attendance inputs for this run, indexed by employee.
  const attendanceRows = await db.attendancePayInput.findMany({
    where: { businessId, payRunId: payRun.id },
  });
  const attendanceByEmp = new Map(attendanceRows.map((a) => [a.employeeId, a]));

  const bundles = [];
  for (const emp of employees) {
    // Resolve the current compensation revision effective on the period end.
    const compensation = await resolveCurrentCompensation(businessId, emp.id, periodEnd, db);
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
        // Feature 21 — the PayRun type drives the once-per-period LWF run-gate in the
        // compliance module: the flat LWF rides only the primary/regular monthly run,
        // never an OFF_CYCLE/ARREAR/SUPPLEMENTARY/BONUS/FNF/CORRECTION run in the same
        // month (which would double-charge the flat welfare fee).
        runType: payRun.type,
      },
      ytd: null,
    });
  }

  // Attach the pay frequency (from the calendar) to every bundle's period.
  const cal = await db.payCalendar.findFirst({ where: { id: payRun.payCalendarId, businessId } });
  const frequency = cal ? cal.frequency : null;
  for (const b of bundles) b.period.frequency = frequency;

  // Cycle-0 wiring — loan/advance recovery: for each employee in the run, select the
  // PENDING installments DUE in this period (dueDate <= periodEnd) from their active
  // loans and attach them to the bundle. buildEmployeePayInput turns the total into a
  // LOAN_REPAYMENT post-tax deduction the ENGINE caps to available net; persistComputedRun
  // then stamps the installments off the engine's ACTUAL recovered figure. A MIGRATED
  // (historical-import) run does NOT recover live loans — it pays a past period.
  if (!isMigrated) {
    for (const b of bundles) {
      const recovery = await loanRecovery.selectDuePending(db, {
        businessId, employeeId: b.employee.id, periodEnd: payRun.periodEnd,
        currentPayRunId: payRun.id,
      });
      if (recovery.totalDueMinor > 0) b.loanRecovery = recovery;
    }
  }

  // SHARED-FILE EDIT (Feature 26 — FLAGGED): reimbursement paid via payroll. For each
  // employee, select their APPROVED + PAY_VIA_PAYROLL claims due in this period and
  // attach them; buildEmployeePayInput emits one EXPENSE_REIMBURSEMENT line the engine
  // adds to net (non-taxable), and persistComputedRun stamps the claims REIMBURSED.
  // V1 pays only the REGULAR monthly run — a reimbursement should not surprise an
  // OFF_CYCLE/BONUS/ARREAR/FNF/CORRECTION/SUPPLEMENTARY run (mirrors the LWF once-per-
  // period gate; spec §10 case 5; make it a setting in V2). MIGRATED selects nothing
  // (a back-dated history run never auto-pays live claims, like loan recovery).
  if (!isMigrated && payRun.type === 'REGULAR') {
    for (const b of bundles) {
      const payout = await reimbursementPayout.selectPayableClaims(db, {
        businessId, employeeId: b.employee.id, periodEnd: payRun.periodEnd,
        currentPayRunId: payRun.id, runCurrency: payRun.currencyCode || null,
      });
      if (payout.totalPayableMinor > 0) b.reimbursementPayout = payout;
    }
  }

  return { entity, bundles };
}

/** Resolve the CompensationRevision effective on `asOf`, with its lines + components. */
async function resolveCurrentCompensation(businessId, employeeId, asOf, db = prisma) {
  const asOfDate = new Date(isoDate(asOf) + 'T00:00:00Z');
  // Prefer the revision whose [effectiveFrom, effectiveTo] window covers asOf.
  const covering = await db.compensationRevision.findFirst({
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
  return db.compensationRevision.findFirst({
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
async function computeRun({ businessId, actorId, payRunId, freezeAttendance: doFreeze = false }) {
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

  // M3/L2 — when freezing, the freeze + bundle-load + compute + persist all run in
  // ONE transaction so a later throw rolls back the AttendancePayInput rows AND the
  // Attendance locks (no half-frozen run), and the FROZEN set is EXACTLY the set
  // compute processes (active + current employment + has-compensation). The engine
  // itself is pure (no DB), so running it inside the tx callback is safe.
  const now = new Date();
  let lines = [];
  let anomalies = [];
  let blockingCount = 0;
  let entity;
  let inputHash;
  let freezeResult = null;

  // Pure per-employee compute (the engine touches no DB). Factored so the DEFAULT
  // path runs the CPU-bound compute OUTSIDE the write transaction — matching the
  // pre-refactor behaviour and avoiding the 5s interactive-tx default timeout on
  // real-size runs — while the freeze path keeps freeze+compute+persist atomic.
  const loadAndCompute = async (client) => {
    const loaded = await loadRunRowBundles(businessId, payRun, client);
    entity = loaded.entity;
    lines = [];
    anomalies = [];
    blockingCount = 0;
    for (const bundle of loaded.bundles) {
      const { engineArgs, meta } = buildEmployeePayInput(bundle);
      let result = computePayslip(engineArgs);
      // Collect anomalies twice: the run-level list carries employeeId; the per-line
      // list keeps the engine shape (no employeeId) so it round-trips through
      // PayRunLine.errorJson the way getRun/approveRun expect.
      const lineAnoms = [];
      const pushAnom = (raw) => {
        anomalies.push({ employeeId: meta.employeeId, ...raw });
        lineAnoms.push(raw);
        if (raw.severity === 'BLOCKER' || raw.severity === 'BLOCK') blockingCount += 1;
      };
      // Feature 26 (FLAGGED) — net-floor SANITY GUARD (spec §6). If a reimbursement would
      // ride a broken/over-deducted payslip or dwarfs salary (typo/fraud), DEFER the WHOLE
      // employee's reimbursement set: strip the EXPENSE_REIMBURSEMENT component, recompute
      // (so net + inputHash exclude it), and clear meta.reimbursementPayout so the claims
      // are NOT stamped — they stay APPROVED and the next regular run picks them up
      // automatically. Never silently partial-pays. Evaluated on the engine's reported
      // figures (no engine fork), exactly as loan recovery's cap lives in the engine.
      if (meta.reimbursementPayout && (result.reimbursementsMinor || 0) > 0) {
        const guard = evaluateReimbursementGuard(result);
        if (guard.defer) {
          const strippedArgs = {
            ...engineArgs,
            components: engineArgs.components.filter((c) => c.code !== 'EXPENSE_REIMBURSEMENT'),
          };
          result = computePayslip(strippedArgs);
          meta.reimbursementPayout = null; // do not stamp the deferred claims
          if (guard.anomaly) pushAnom(guard.anomaly);
        }
      }
      for (const a of meta.preAnomalies || []) pushAnom(a); // M2 OT_HOURS_UNCONSUMED
      for (const a of (freezeResult ? freezeResult.anomalies : []) || []) {
        if (a.employeeId === meta.employeeId) { const { employeeId: _e, ...rest } = a; pushAnom(rest); } // H3
      }
      for (const a of result.anomalies || []) pushAnom(a);
      // Feature 16 — surface an INFO anomaly per employee carrying LOP so the
      // run-review checker sees it (not a blocker). Authorised LWP vs AWOL absent
      // are distinguished by the lwp/absent split.
      if ((meta.lopDays || 0) > 0) {
        pushAnom({
          code: 'LWP_LOP_APPLIED',
          severity: 'INFO',
          message: `Loss of Pay applied: ${meta.lopDays} day(s) LOP (${meta.lwpDays || 0} approved LWP, ${meta.absentDays || 0} absent) on ${meta.standardDays || meta.payableDays} standard days; pay prorated to ${meta.payableDays} payable days.`,
        });
      }
      lines.push({
        employeeId: meta.employeeId,
        compensationId: meta.compensationId,
        payableDays: meta.payableDays,
        lopDays: meta.lopDays,
        lwpDays: meta.lwpDays,
        absentDays: meta.absentDays,
        standardDays: meta.standardDays,
        overtimeHours: meta.overtimeHours,
        employeeCode: bundle.employee.code,
        result,
        // Cycle-0 — the due installments to stamp from the engine's actual recovery.
        loanRecovery: meta.loanRecovery || null,
        // Feature 26 (FLAGGED) — the claims to stamp REIMBURSED from the engine's actual
        // EXPENSE_REIMBURSEMENT line (persistComputedRun applies the net-floor guard first).
        reimbursementPayout: meta.reimbursementPayout || null,
        allAnomalies: lineAnoms, // persisted to errorJson so warnings survive re-read
      });
    }
    // Content-address the frozen inputs for idempotency (§11.1).
    inputHash = computeInputHash({
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
  };

  // Explicit long timeout: a real-size payroll run's compute + per-line writes must
  // not race Prisma's 5s interactive-transaction default (P2028 would roll back the
  // whole computed run).
  const TX_OPTS = { timeout: 120000, maxWait: 15000 };
  if (doFreeze) {
    // Freeze + compute + persist atomically (M3): a later throw rolls back the
    // AttendancePayInput rows AND the Attendance locks (no half-frozen run), and the
    // frozen set is EXACTLY the set compute pays (L2).
    await prisma.$transaction(async (tx) => {
      const pre = await loadRunRowBundles(businessId, payRun, tx);
      const freezeIds = pre.bundles.map((b) => b.employee.id);
      if (freezeIds.length) {
        // Feature 16 — freeze the entity's proration basis into the inputs so the
        // proration denominator (standardDays) is immutable + part of the inputHash.
        freezeResult = await freezeAttendance(
          payRun.id, businessId, payRun.periodStart, payRun.periodEnd, freezeIds, tx,
          { prorationBasis: pre.entity && pre.entity.prorationBasis },
        );
      }
      await loadAndCompute(tx);
      await persistComputedRun(tx, { businessId, payRun, actorId, now, inputHash, lines });
    }, TX_OPTS);
  } else {
    // Default path — compute OUTSIDE the write tx; only persistence is transactional.
    await loadAndCompute(prisma);
    await prisma.$transaction(
      (tx) => persistComputedRun(tx, { businessId, payRun, actorId, now, inputHash, lines }),
      TX_OPTS,
    );
  }

  const detail = await getRun({ businessId, payRunId });
  detail.anomalies = anomalies;
  detail.blockingAnomalies = blockingCount;
  return detail;
}

/**
 * persistComputedRun — the DB-writing half of computeRun, factored out so the
 * freeze + compute + persist can share one transaction (M3). Runs the pure
 * state-machine guard, writes the COMPUTED status + inputHash, clears prior
 * artefacts, then persists PayRunLine + components + payslips and the run totals.
 * `tx` MUST be a Prisma transaction client.
 */
async function persistComputedRun(tx, { businessId, payRun, actorId, now, inputHash, lines }) {
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

  // Cycle-0 — UNWIND any loan stamps a PRIOR compute of THIS run wrote (reset the
  // installments to PENDING + reverse the Loan running totals) BEFORE re-applying.
  // This is what makes the recovery idempotent: recompute never double-deducts, and
  // a reopened/cancelled run that re-runs starts from a clean slate. Same tx as the
  // re-apply below, so the unwind+reapply is atomic.
  await loanRecovery.unwindForRun(tx, { businessId, payRunId: payRun.id });

  // Feature 26 (FLAGGED) — UNWIND any reimbursement stamps a PRIOR compute of THIS run
  // wrote (reset the claims to APPROVED + clear payRunId/paidViaPayrollAmount) BEFORE
  // re-applying. Same idempotency model as loan recovery: recompute never double-pays,
  // and a reopened/cancelled run that re-runs starts from a clean slate. Same tx as the
  // re-apply below, so unwind+reapply is atomic. Only releases claims THIS pass stamped
  // (paidViaPayrollAmount set) — never a manually-reimbursed PAY_SEPARATELY claim.
  await reimbursementPayout.unwindForRun(tx, { businessId, payRunId: payRun.id });

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
        lwpDays: ln.lwpDays || 0, // Feature 16 — approved LWP days provenance
        overtimeHours: ln.overtimeHours || 0,
        grossEarnings: toDec(r.grossMinor),
        totalDeductions: toDec(r.totalEmployeeDeductionsMinor),
        netPay: toDec(r.netMinor),
        employerCost: toDec(r.totalEmployerContributionsMinor),
        currencyCode: payRun.currencyCode,
        status: 'COMPUTED',
        computeTrace: r.explain || null,
        errorJson: (ln.allAnomalies && ln.allAnomalies.length) ? ln.allAnomalies : undefined,
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

    // Cycle-0 — STAMP the loan recovery off the engine's ACTUAL recovered figure.
    // The engine has already applied the net-floor cap to the LOAN_REPAYMENT line;
    // we read what it actually deducted (not what we asked for) so a capped/partial
    // recovery is credited to the paise and the residual defers. applyRecovery credits
    // the loan EXACTLY this figure (debit == credit == installment recoveredAmount),
    // marks fully-covered installments PAID and leaves a net-capped trailing one
    // PENDING with a partial recoveredAmount, increments Loan.amountRepaid / decrements
    // outstanding, and closes a fully-recovered loan — all in THIS run transaction.
    //
    // CONCURRENCY: we RE-SELECT the due installments INSIDE this persist tx with a
    // row lock (selectDuePending → SELECT … FOR UPDATE SKIP LOCKED). The default
    // compute path selected them earlier on the non-tx client (lock not held), so a
    // racing run could otherwise stamp the same PENDING installment. Re-selecting
    // under lock here is the authoritative set: a row a concurrent run already PAID is
    // now excluded (status <> PAID) / skip-locked, so we never double-recover. The
    // unwind above already reset THIS run's own prior stamps, so the lock re-select
    // reproduces the original set on a clean recompute.
    if (ln.loanRecovery && ln.loanRecovery.installments && ln.loanRecovery.installments.length) {
      const recoveredMinor = (r.employeeDeductions || [])
        .filter((d) => d.code === 'LOAN_REPAYMENT')
        .reduce((acc, d) => acc + (d.amountMinor || 0), 0);
      if (recoveredMinor > 0) {
        const locked = await loanRecovery.selectDuePending(tx, {
          businessId,
          employeeId: ln.employeeId,
          periodEnd: payRun.periodEnd,
          currentPayRunId: payRun.id,
        });
        // Credit the engine-recovered figure across the LOCKED set, but never beyond
        // what is actually recoverable under the lock (a concurrent run may have taken
        // some). recoveredMinor (the debit) == the credit in the normal, race-free case.
        const creditable = Math.min(recoveredMinor, locked.totalDueMinor);
        if (creditable > 0) {
          await loanRecovery.applyRecovery(tx, {
            businessId,
            payRunId: payRun.id,
            paidAt: now,
            installments: locked.installments,
            recoveredMinor: creditable,
          });
        }
      }
    }

    // Feature 26 (FLAGGED) — STAMP the reimbursement payout off the engine's ACTUAL
    // EXPENSE_REIMBURSEMENT figure (the line ADDED to net; the net-floor guard already
    // deferred any employee whose set was unsafe, clearing ln.reimbursementPayout so we
    // never reach here for them). Mirror of the loan-stamp block as a POSITIVE payment:
    // re-select the claims UNDER LOCK inside this persist tx (the default compute path
    // selected them earlier on the non-tx client, lock not held, so a racing run could
    // otherwise grab the same APPROVED claim) and stamp each REIMBURSED + payRunId +
    // paidViaPayrollAmount. The unwind above already released THIS run's own prior
    // stamps, so the lock re-select reproduces the original set on a clean recompute.
    // paidMinor (the credit) == Σ claim amounts in the normal, race-free case.
    if (ln.reimbursementPayout && ln.reimbursementPayout.claims && ln.reimbursementPayout.claims.length) {
      const paidMinor = (r.reimbursements || [])
        .filter((rb) => rb.code === 'EXPENSE_REIMBURSEMENT')
        .reduce((acc, rb) => acc + (rb.amountMinor || 0), 0);
      if (paidMinor > 0) {
        const locked = await reimbursementPayout.selectPayableClaims(tx, {
          businessId,
          employeeId: ln.employeeId,
          periodEnd: payRun.periodEnd,
          currentPayRunId: payRun.id,
          runCurrency: payRun.currencyCode || null,
        });
        // Pay the engine-reported figure across the LOCKED set, never beyond what is
        // actually payable under the lock (a concurrent run may have taken some claims).
        const payable = Math.min(paidMinor, locked.totalPayableMinor);
        if (payable > 0) {
          await reimbursementPayout.applyPayout(tx, {
            businessId,
            payRunId: payRun.id,
            paidAt: now,
            actorId,
            claims: locked.claims,
            paidMinor: payable,
          });
        }
      }
    }

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
}

/** Minor units -> Decimal string "x.xx" (scale 2). No float. */
function toDec(minor) {
  return money.fromMinor(minor, 2);
}

/** Map known statutory codes to PayRunLine rollup columns (Decimal). */
function statutoryRollups(r) {
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
    for (const c of codes) if (byCode[c] != null) return toDec(byCode[c]);
    return null;
  };
  // Pick the actual statutory WAGE BASE the engine computed a component on (the
  // real ECR/24Q wage), NOT a contribution back-derived by dividing by a rate.
  const pickBase = (...codes) => {
    for (const c of codes) if (baseByCode[c] != null) return toDec(baseByCode[c]);
    return null;
  };
  return {
    pfEmployee: pick('EPF', 'EPF_EE'),
    pfEmployer: pick('EPF_ER'),
    esiEmployee: pick('ESI', 'ESI_EE'),
    esiEmployer: pick('ESI_ER'),
    pt: pick('PT'),
    // Feature 21 — Labour Welfare Fund EE deduction + ER contribution (period-incident;
    // null/absent in non-deduction months, exactly like a no-PT state yields null pt).
    lwfEmployee: pick('LWF', 'LWF_EE'),
    lwfEmployer: pick('LWF_ER'),
    tds: pick('TDS'),
    paye: pick('PAYE'),
    kiwiSaverEmployee: pick('KIWISAVER', 'KIWISAVER_EE'),
    kiwiSaverEmployer: pick('KIWISAVER_ER'),
    esct: pick('ESCT'),
    accLevy: pick('ACC'),
    studentLoan: pick('SLOAN', 'STUDENT_LOAN'),
    // Persist the real PF/EPS/EDLI wage bases so filing reads them straight through.
    pfWagesBase: pickBase('EPF', 'EPF_EE', 'EPF_ER'),
    epsWagesBase: pickBase('EPS_ER', 'EPS'),
    edliWagesBase: pickBase('EDLI'),
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
    // Feature 16 — LOP attendance provenance + an INFORMATIONAL Loss-of-Pay line.
    // The net ALREADY reflects the reduction (the engine prorated earnings down);
    // this block only EXPLAINS it. `lop.amount` is NOT summed into deductions/net —
    // it is the days × per-day-rate figure shown so an employee/auditor sees why pay
    // dropped. Per-day rate = full (unprorated) gross ÷ standardDays.
    attendance: buildLopProvenance(r, ln),
  };
}

/**
 * buildLopProvenance(r, ln) — the payslip's attendance/LOP provenance block.
 * Returns null when there is no LOP (clean payslip, nothing to explain).
 * PURE: no DB.
 *   standardDays / payableDays / lopDays / lwpDays / absentDays — frozen inputs.
 *   perDayRate = gross ÷ payableDays   (the rate that, × payableDays, equals the
 *                prorated gross — the value an employee intuitively reads); falls
 *                back to gross ÷ standardDays when payableDays is 0.
 *   lop.amount = lopDays × (full-gross ÷ standardDays)  (informational only).
 */
function buildLopProvenance(r, ln) {
  const toMajor = (m) => money.fromMinor(m, 2);
  const lopDays = Number(ln && ln.lopDays) || 0;
  const standardDays = Number(ln && ln.standardDays) || 0;
  const payableDays = Number(ln && ln.payableDays) || 0;
  const lwpDays = Number(ln && ln.lwpDays) || 0;
  const absentDays = Number(ln && ln.absentDays) || 0;
  const prov = {
    standardDays,
    payableDays,
    lopDays,
    lwpDays,
    absentDays,
    // half-day / other LOP that is neither approved-LWP nor full-day-absent
    otherLopDays: Math.round((lopDays - lwpDays - absentDays) * 1e4) / 1e4,
  };
  // F16 review fix (LOW#1) — only render the informational LOP line when the engine
  // ACTUALLY reduced gross, i.e. payableDays < standardDays. If lopDays>0 yet
  // payableDays ≥ standardDays the engine clamped to full pay (it was a basis
  // mismatch — now fixed at freeze — or a FIXED_REGARDLESS component), so net was
  // NOT reduced; printing a non-zero "Loss of Pay" figure here would contradict the
  // actual net (a self-contradictory payslip). Suppress the line in that case; the
  // raw day counts (lopDays/lwpDays/absentDays) still surface for transparency.
  if (lopDays <= 0 || standardDays <= 0 || payableDays >= standardDays) return prov;

  // Full (unprorated) gross = prorated gross × standard / payable. Recover it so the
  // per-day rate matches what payroll prorated against (exact rational, paise-safe).
  // payableDays is now guaranteed 0 < payableDays < standardDays whenever lop>0.
  const grossMinor = r.grossMinor || 0;
  let fullGrossMinor = grossMinor;
  if (payableDays > 0) {
    fullGrossMinor = money.roundRational(
      grossMinor * Math.round(standardDays * 10000),
      Math.round(payableDays * 10000),
      money.RoundingMode.HALF_UP,
    );
  }
  const perDayMinor = money.roundRational(
    fullGrossMinor * 10000, Math.round(standardDays * 10000), money.RoundingMode.HALF_UP,
  );
  const lopMinor = money.roundRational(
    fullGrossMinor * Math.round(lopDays * 10000),
    Math.round(standardDays * 10000),
    money.RoundingMode.HALF_UP,
  );
  prov.perDayRate = toMajor(perDayMinor);
  prov.lop = {
    code: 'LOP',
    label: `Loss of Pay — ${lopDays} day(s) (${lwpDays} LWP, ${absentDays} absent)`,
    amount: toMajor(lopMinor), // shown as a reduction; NOT summed into deductions/net
    days: lopDays,
    informational: true,
  };
  return prov;
}

/**
 * approveRun — maker-checker. ALL integrity gates are SERVER-SIDE; the caller
 * supplies only { businessId, actorId, payRunId } — there is NO client-supplied
 * fourEyes/totalsHash that can weaken separation-of-duties or the staleness gate:
 *   - variance BLOCKERs are materialised FRESH here, then counted (fail-closed);
 *   - four-eyes is derived from tenant policy (maker≠checker, server-enforced);
 *   - STALE_TOTALS is recomputed from persisted totals vs the reviewed anchor.
 * Transitions COMPUTED|REVIEW -> APPROVED via persistTransition.
 *
 * @param {Object} args { businessId, actorId, payRunId }
 */
async function approveRun({ businessId, actorId, payRunId }) {
  const payRun = await prisma.payRun.findFirst({ where: { id: payRunId, businessId } });
  if (!payRun) throw notFound('Pay run not found');

  if (payRun.status !== 'COMPUTED' && payRun.status !== 'REVIEW') {
    throw badRequest('NOT_CALCULATED', `Approval requires a COMPUTED or REVIEW run (current: ${payRun.status})`);
  }

  // (1) FAIL-CLOSED variance gate (finding #1): materialise the BLOCKER set FRESH
  // from the current persisted lines AT APPROVE — never trust that the operator
  // (or submit) already ran variance. An unreviewed run with blockers cannot be
  // approved even on the direct CALCULATED→APPROVED path.
  await computeVariance({ businessId, payRunId });
  const blockingAnomalies = await recountBlockers(businessId, payRunId);

  // (2) Four-eyes is a SERVER-SIDE invariant (finding #2): derived from tenant
  // policy, NEVER from the request. {fourEyes:false} in a body is ignored.
  const fourEyes = await resolveFourEyesPolicy(businessId);

  // (3) STALE_TOTALS server-side (finding #3): recompute the CURRENT totals hash
  // from the persisted run and compare to the hash captured at submit/compute.
  // A silent recompute since review changes the hash → reject, independent of any
  // client-echoed value. Re-read the run so the totals reflect any recompute.
  const fresh = await prisma.payRun.findFirst({ where: { id: payRunId, businessId } });
  const currentTotalsHash = totalsHashOf(fresh);
  if (fresh.totalsHash != null && currentTotalsHash !== fresh.totalsHash) {
    throw badRequest(
      'STALE_TOTALS',
      'Totals changed since review — re-open and re-review before approving.',
    );
  }
  // Anchor the reviewed-totals invariant on the direct (no-submit) path, where no
  // totalsHash was ever stored, so the artifact the checker approves is pinned.
  const anchoredHash = fresh.totalsHash != null ? fresh.totalsHash : currentTotalsHash;

  // Pure state-machine guard (NOT_CALCULATED, MAKER_CHECKER, OPEN_BLOCKERS). The
  // identity check is unconditional when fourEyes is on (server-resolved); we pass
  // the server-resolved hash so an internal STALE check stays consistent.
  const from = payRun.status === 'REVIEW' ? STATE.IN_REVIEW : STATE.CALCULATED;
  const runState = {
    id: payRun.id,
    status: from,
    preparerId: payRun.computedBy || payRun.lockedBy,
    submittedBy: payRun.submittedBy || null,
    totalsHash: anchoredHash,
    blockingAnomalies,
    fourEyes,
  };
  transition(runState, STATE.APPROVED, { actorId, at: new Date(), blockingAnomalies, fourEyes, totalsHash: anchoredHash });

  await persistTransition({ prisma, payRunId, from, to: STATE.APPROVED, ctx: { actorId, totalsHash: anchoredHash } });

  // Sensitive action — audit the approval (best-effort, tenant-scoped).
  await writeAudit({
    businessId,
    actorId,
    action: 'payrun.approve',
    entityType: 'PayRun',
    entityId: payRunId,
    meta: {
      code: payRun.code,
      entityId: payRun.entityId,
      periodStart: isoDate(payRun.periodStart),
      periodEnd: isoDate(payRun.periodEnd),
      fourEyes,
      preparerId: payRun.computedBy || payRun.lockedBy || null,
      submitterId: payRun.submittedBy || null,
      reviewerId: actorId,
      totalsHash: anchoredHash,
    },
  });

  return getRun({ businessId, payRunId });
}

/**
 * listRuns — paginated list, tenant-scoped. Feature 7: a `type` filter so FnF
 * runs don't leak into the regular list. Default behaviour excludes FNF (the
 * regular console hides them); pass `includeFnf:true` or `type:'FNF'` to see them.
 */
async function listRuns({ businessId, entityId, status, type, includeFnf = false, taxYear, page = 1, pageSize = 25 }) {
  const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const where = { businessId, deletedAt: null };
  if (entityId) where.entityId = entityId;
  if (status) where.status = status;
  if (taxYear) where.taxYear = taxYear;
  if (type) {
    where.type = type;
  } else if (!includeFnf && String(includeFnf) !== 'true') {
    where.type = { not: 'FNF' };
  }
  const [items, total] = await Promise.all([
    prisma.payRun.findMany({
      where, orderBy: { periodStart: 'desc' }, skip, take,
      include: { entity: { select: { id: true, code: true, legalName: true, countryCode: true } } },
    }),
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
    // Variance findings live in a separate column (finding #7) — surface both.
    const varns = Array.isArray(l.varianceJson) ? l.varianceJson : [];
    for (const v of varns) anomalies.push({ employeeId: l.employeeId, ...v });
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

/** getMyPayslips — the logged-in EMPLOYEE's own payslips (ESS).
 * Backward-compatible pagination: with no page/pageSize the full self-scoped list
 * is returned (shape `{ items, total }` as before). When the caller passes
 * page/pageSize, a LIMIT/OFFSET window + a scoped COUNT are used and the response
 * gains page/pageSize. The self-only employeeId scope is applied on BOTH paths
 * (query AND count) so a paged read can never leak another employee's payslips. */
async function getMyPayslips({ businessId, customer, page, pageSize } = {}) {
  const paged = page !== undefined || pageSize !== undefined;
  const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const employeeId = await resolveSelfEmployee(businessId, customer);
  if (!employeeId) return paged ? { items: [], total: 0, page: pageNum, pageSize: take } : { items: [], total: 0 };
  const where = { businessId, employeeId, deletedAt: null, status: { in: ['PUBLISHED', 'VIEWED'] } };
  const select = {
    id: true, code: true, periodStart: true, periodEnd: true, payDate: true,
    currencyCode: true, grossEarnings: true, totalDeductions: true, netPay: true, status: true,
  };
  if (!paged) {
    const items = await prisma.payslip.findMany({ where, orderBy: { payDate: 'desc' }, select });
    return { items, total: items.length };
  }
  const [items, total] = await Promise.all([
    prisma.payslip.findMany({ where, orderBy: { payDate: 'desc' }, select, skip: (pageNum - 1) * take, take }),
    prisma.payslip.count({ where }),
  ]);
  return { items, total, page: pageNum, pageSize: take };
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

/**
 * getMyPayslipPdfContext — the SECURE PDF context for the ESS download.
 *
 * Resolves the payslip via getMyPayslip (which enforces employee-own + PUBLISHED
 * scoping AND marks the first view), then loads the employee + business identity
 * the renderer needs. Security is unchanged: ALL scoping flows through
 * getMyPayslip; this only adds read-only identity for the header/employee block.
 *
 * @returns {{ payslip, employee, business }}
 */
async function getMyPayslipPdfContext({ businessId, customer, payslipId }) {
  const payslip = await getMyPayslip({ businessId, customer, payslipId });
  return resolvePayslipPdfIdentity({ businessId, payslip });
}

/**
 * resolvePayslipPdfIdentity — shared identity loader for the payslip renderer.
 * Given an already-scoped `payslip`, loads the employee + department/designation
 * + business identity blocks the PDF header needs. Tenant-scoped, read-only.
 * Used by BOTH the ESS download and the operator download so the two paths
 * render an identical document from the same frozen snapshot.
 */
async function resolvePayslipPdfIdentity({ businessId, payslip }) {
  // Employee identity, tenant-scoped.
  const employee = await prisma.employee.findFirst({
    where: { id: payslip.employeeId, businessId, deletedAt: null },
    select: {
      id: true, code: true, firstName: true, middleName: true, lastName: true,
      preferredName: true, currentEmploymentRecordId: true,
    },
  });

  // Current department/designation: the pointed-at employment record, else the
  // latest by effectiveFrom. (There is no scalar->relation on Employee.)
  let department = null;
  let designation = null;
  if (employee) {
    const cer = await prisma.employmentRecord.findFirst({
      where: employee.currentEmploymentRecordId
        ? { id: employee.currentEmploymentRecordId, businessId }
        : { employeeId: employee.id, businessId },
      orderBy: { effectiveFrom: 'desc' },
      select: {
        department: { select: { name: true } },
        designation: { select: { title: true } }, // Designation uses `title`, not `name`
      },
    });
    department = cer && cer.department ? cer.department.name : null;
    designation = cer && cer.designation ? cer.designation.title : null;
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true, name: true },
  });

  const identity = employee
    ? {
        id: employee.id,
        code: employee.code,
        firstName: employee.firstName,
        middleName: employee.middleName,
        lastName: employee.lastName,
        preferredName: employee.preferredName,
        department,
        designation,
      }
    : null;

  return { payslip, employee: identity, business: business || { id: businessId } };
}

/**
 * getPayslipPdfContext — the OPERATOR PDF context (finding #23). Operator
 * payslip view is gated by canViewPayrollReports (route RBAC), so unlike the ESS
 * path it does NOT require PUBLISHED/employee-own — an operator can render any
 * run payslip in the tenant. Scoping is strictly by businessId; the payslip must
 * exist, not be soft-deleted, and carry a frozen snapshot to render.
 */
async function getPayslipPdfContext({ businessId, payslipId }) {
  const payslip = await prisma.payslip.findFirst({
    where: { id: payslipId, businessId, deletedAt: null },
  });
  if (!payslip) throw notFound('Payslip not found');
  return resolvePayslipPdfIdentity({ businessId, payslip });
}

/**
 * recordPayslipPdfHash — persist the SHA-256 of the rendered PDF (tamper
 * evidence). Tenant-scoped, idempotent (skips the write when unchanged). Called
 * best-effort from the controller; failures here never block the download.
 */
async function recordPayslipPdfHash({ businessId, payslipId, pdfHash }) {
  if (!pdfHash) return;
  await prisma.payslip.updateMany({
    where: { id: payslipId, businessId, deletedAt: null, NOT: { pdfHash } },
    data: { pdfHash },
  });
}

// ===========================================================================
//  FEATURE 7 — RUN ORCHESTRATION (checklist · one-time · variance · lifecycle)
//
//  Thin wrappers over the engine + the PURE variance engine + persistTransition.
//  The math/state-graph never lives here; this layer only loads rows, calls the
//  pure functions, and writes the result. Every fn is tenant-scoped (businessId).
// ===========================================================================

/**
 * listRunEntities — entities + their pay calendars for the NewRunModal pickers
 * (§6.1: replace free-text UUIDs with selects). Tenant-scoped, read-only.
 */
async function listRunEntities({ businessId }) {
  const entities = await prisma.entity.findMany({
    where: { businessId, deletedAt: null },
    select: {
      id: true, code: true, legalName: true, countryCode: true, payCurrency: true,
      taxYearStartMonth: true,
    },
    orderBy: { code: 'asc' },
  });
  const calendars = await prisma.payCalendar.findMany({
    where: { businessId, isActive: true },
    select: {
      id: true, entityId: true, code: true, name: true, frequency: true,
      payDayRule: true, payDayValue: true,
    },
    orderBy: { code: 'asc' },
  });
  const byEntity = new Map();
  for (const c of calendars) {
    if (!byEntity.has(c.entityId)) byEntity.set(c.entityId, []);
    byEntity.get(c.entityId).push(c);
  }
  return {
    items: entities.map((e) => ({ ...e, payCalendars: byEntity.get(e.id) || [] })),
  };
}

/** Load a PayRun (tenant-scoped) or throw a 404. Optionally include the entity. */
async function loadRun(businessId, payRunId, withEntity = false) {
  const payRun = await prisma.payRun.findFirst({
    where: { id: payRunId, businessId, deletedAt: null },
    include: withEntity ? { entity: true } : undefined,
  });
  if (!payRun) throw notFound('Pay run not found');
  return payRun;
}

/** Map the prisma status (+ closedAt) to the engine STATE the state machine uses. */
function engineStateOf(payRun) {
  if (payRun.status === 'FILED' && payRun.closedAt) return STATE.CLOSED;
  return PRISMA_TO_STATE[payRun.status] || payRun.status;
}

/**
 * getInputsChecklist — read-only readiness gates for the inputs tab (§6.2).
 * Pure-ish: reads attendance-freeze coverage, pending comp revisions effective in
 * the period, and the count of one-time items. No mutation.
 */
async function getInputsChecklist({ businessId, payRunId }) {
  const payRun = await loadRun(businessId, payRunId);
  const { entity, bundles } = await loadRunRowBundles(businessId, payRun);
  const headcount = bundles.length;

  // Attendance freeze coverage for this run.
  const frozen = await prisma.attendancePayInput.count({ where: { businessId, payRunId } });
  const attendanceRow = {
    key: 'attendance', label: 'Attendance freeze',
    status: frozen >= headcount && headcount > 0 ? 'OK'
      : frozen === 0 ? 'WARN' : 'PARTIAL',
    detail: frozen === 0
      ? 'No frozen attendance — the run will pay full calendar days (NO_ATTENDANCE_DATA).'
      : `${frozen} of ${headcount} employees frozen.`,
    code: frozen === 0 ? 'NO_ATTENDANCE_DATA' : null,
    frozen, headcount,
  };

  // Leave / LOP — surfaced from frozen lopDays (drawer detail in the UI).
  // Feature 16 — also expose the lwp/absent split + the proration denominator so the
  // checker reads "3 LWP-approved, 1 absent on 31 standard days", not an opaque "4 LOP".
  const lopRows = await prisma.attendancePayInput.findMany({
    where: { businessId, payRunId, lopDays: { gt: 0 } },
    select: { employeeId: true, lopDays: true, lwpDays: true, absentDays: true, payableDays: true, standardDays: true },
  });
  const leaveRow = {
    key: 'leave', label: 'Leave / LOP',
    status: lopRows.length ? 'INFO' : 'OK',
    detail: lopRows.length ? `${lopRows.length} employee(s) carry loss-of-pay days.` : 'No loss-of-pay this period.',
    items: lopRows.map((r) => ({
      employeeId: r.employeeId,
      lopDays: Number(r.lopDays),
      lwpDays: Number(r.lwpDays || 0),
      absentDays: Number(r.absentDays || 0),
      payableDays: Number(r.payableDays || 0),
      standardDays: Number(r.standardDays || 0),
    })),
  };

  // Pending comp revisions effective in-period but not yet current.
  const periodStart = new Date(isoDate(payRun.periodStart) + 'T00:00:00Z');
  const periodEnd = new Date(isoDate(payRun.periodEnd) + 'T00:00:00Z');
  const pendingRevs = await prisma.compensationRevision.count({
    where: {
      businessId,
      effectiveFrom: { gte: periodStart, lte: periodEnd },
      isCurrent: false,
      status: { in: ['PROPOSED', 'APPROVED'] },
    },
  }).catch(() => 0);
  const revisionRow = {
    key: 'revisions', label: 'Pending comp revisions',
    status: pendingRevs ? 'WARN' : 'OK',
    detail: pendingRevs ? `${pendingRevs} revision(s) effective this period not yet applied.` : 'No pending revisions.',
    count: pendingRevs,
  };

  // One-time inputs. Resolve subject employee names so the editor renders names,
  // not raw UUIDs (finding #25 premium UX). PayRunInputItem carries only a scalar
  // employeeId, so we batch-load the referenced employees and decorate.
  const oneTime = await prisma.payRunInputItem.findMany({
    where: { businessId, payRunId },
    orderBy: { createdAt: 'asc' },
  });
  const oneTimeEmpIds = [...new Set(oneTime.map((it) => it.employeeId).filter(Boolean))];
  const oneTimeEmps = oneTimeEmpIds.length
    ? await prisma.employee.findMany({
        where: { id: { in: oneTimeEmpIds }, businessId },
        select: { id: true, code: true, firstName: true, lastName: true },
      })
    : [];
  const empById = new Map(oneTimeEmps.map((e) => [e.id, e]));
  const oneTimeRow = {
    key: 'oneTime', label: 'One-time inputs',
    status: 'OK',
    detail: oneTime.length ? `${oneTime.length} one-time item(s) staged.` : 'No one-time items.',
    editable: payRun.status === 'DRAFT',
    items: oneTime.map((it) => serializeInputItem(it, empById.get(it.employeeId))),
  };

  return {
    payRunId, status: payRun.status, entity: { id: entity.id, countryCode: entity.countryCode },
    headcount,
    rows: [attendanceRow, leaveRow, revisionRow, oneTimeRow],
    canCompute: payRun.status === 'DRAFT' || payRun.status === 'INPUTS_LOCKED',
  };
}

/** BigInt-safe serialization of a PayRunInputItem (amountMinor is BigInt). */
function serializeInputItem(it, employee) {
  const name = employee
    ? ([employee.firstName, employee.lastName].filter(Boolean).join(' ') || employee.code || null)
    : null;
  return {
    id: it.id, payRunId: it.payRunId, employeeId: it.employeeId, kind: it.kind,
    componentCode: it.componentCode, amountMinor: Number(it.amountMinor),
    sourcePeriod: it.sourcePeriod, taxable: it.taxable, note: it.note,
    createdBy: it.createdBy, createdAt: it.createdAt,
    // Decorated for the editor UI (finding #25); absent on bare create/update echoes.
    employeeName: name,
    employeeCode: employee ? employee.code || null : null,
  };
}

/**
 * upsertOneTimeInput — DRAFT-only CRUD for one-time / ad-hoc inputs (§5.2).
 * Create (no id), update (id), or delete (id + _delete). BAD_STATE outside DRAFT.
 */
async function upsertOneTimeInput({ businessId, actorId, payRunId, item }) {
  const payRun = await loadRun(businessId, payRunId);
  if (payRun.status !== 'DRAFT') {
    throw badRequest('BAD_STATE', 'One-time inputs are editable only while the run is DRAFT.');
  }
  if (!item || !item.employeeId || !item.kind) {
    throw badRequest('MISSING_FIELDS', 'employeeId and kind are required.');
  }
  const KINDS = ['OTE', 'OTD', 'ARREAR', 'REIMBURSEMENT'];
  if (!KINDS.includes(item.kind)) throw badRequest('MISSING_FIELDS', `kind must be one of ${KINDS.join(', ')}`);

  if (item.id && item._delete) {
    await prisma.payRunInputItem.deleteMany({ where: { id: item.id, businessId, payRunId } });
    return { deleted: item.id };
  }

  const data = {
    businessId, payRunId, employeeId: item.employeeId, kind: item.kind,
    componentCode: item.componentCode || null,
    amountMinor: BigInt(Math.round(Number(item.amountMinor) || 0)),
    sourcePeriod: item.sourcePeriod || null,
    taxable: item.taxable !== false,
    note: item.note || null,
  };
  if (item.id) {
    const upd = await prisma.payRunInputItem.updateMany({
      where: { id: item.id, businessId, payRunId },
      data: { ...data, version: { increment: 1 } },
    });
    if (upd.count === 0) throw notFound('One-time input not found');
    const row = await prisma.payRunInputItem.findUnique({ where: { id: item.id } });
    return serializeInputItem(row);
  }
  const row = await prisma.payRunInputItem.create({ data: { ...data, createdBy: actorId || 'system' } });
  return serializeInputItem(row);
}

/**
 * loadVarianceLines — map persisted PayRunLine rows into the PURE variance line
 * shape. DB-touching; the variance math stays pure. Returns lines + totalsMinor.
 */
function varianceLineFromRow(line, ctx = {}) {
  return {
    employeeId: line.employeeId,
    status: line.status,
    grossMinor: decimalToMinor(line.grossEarnings),
    netMinor: decimalToMinor(line.netPay),
    payableDays: line.payableDays == null ? null : toNum(line.payableDays),
    lopDays: line.lopDays == null ? 0 : toNum(line.lopDays),
    components: (line.components || []).map((c) => ({
      code: c.componentCode, amountMinor: decimalToMinor(c.amount), statutory: !!c.isStatutory,
    })),
    isNewJoiner: !!ctx.isNewJoiner,
    isLeaver: !!ctx.isLeaver,
    hasCompRevision: !!ctx.hasCompRevision,
    hasArrear: !!ctx.hasArrear,
    hasBankDetail: ctx.hasBankDetail,
  };
}

/** Resolve the per-tenant variance thresholds (config override of the defaults). */
async function resolveThresholds(businessId) {
  const row = await prisma.varianceThreshold.findUnique({ where: { businessId } }).catch(() => null);
  return row && row.config && typeof row.config === 'object'
    ? { ...variance.DEFAULT_THRESHOLDS, ...row.config }
    : variance.DEFAULT_THRESHOLDS;
}

/**
 * resolveFourEyesPolicy — derive the four-eyes (maker≠checker) requirement
 * SERVER-SIDE from persisted tenant config, NOT from the request body (finding
 * #2). Four-eyes is ON by default and can ONLY be relaxed by an explicitly-
 * persisted tenant flag `allowSingleOperator:true` (a deliberate single-operator
 * tenant) — never by anything the approver can set on their own request. A
 * client-supplied {fourEyes:false} CANNOT disable separation of duties.
 *
 * @returns {boolean} true => enforce maker≠checker.
 */
async function resolveFourEyesPolicy(businessId) {
  const row = await prisma.varianceThreshold.findUnique({ where: { businessId } }).catch(() => null);
  const cfg = row && row.config && typeof row.config === 'object' ? row.config : {};
  // Only an explicit, persisted single-operator opt-in relaxes four-eyes.
  return cfg.allowSingleOperator === true ? false : true;
}

/**
 * computeVariance — fetch the prior period (same entity+calendar+type, the
 * immediately-lower sequenceInYear), run the PURE variance engine, persist the
 * per-line findings to PayRunLine.errorJson (BLOCKER/WARNING only) and the
 * run-level roll-up to PayRun.varianceReport. Returns the report.
 */
// Statuses on which computeVariance may mutate findings. Variance is a
// PRE-APPROVAL tool; once APPROVED/PAID/FILED/CLOSED the reviewed/closed artifact
// is immutable — refuse to overwrite varianceJson/varianceReport (finding #4).
const VARIANCE_MUTABLE_STATUSES = new Set(['DRAFT', 'INPUTS_LOCKED', 'COMPUTED', 'REVIEW']);

async function computeVariance({ businessId, payRunId }) {
  const payRun = await loadRun(businessId, payRunId, true);

  // Immutability guard — never recompute/overwrite variance on a run that is
  // APPROVED or past, or already CLOSED. (Mirrors persistComputedRun's
  // IMMUTABLE_RUN_VIOLATION; variance is read-only once approved.)
  if (!VARIANCE_MUTABLE_STATUSES.has(payRun.status) || payRun.closedAt) {
    throw badRequest(
      'IMMUTABLE_RUN_VIOLATION',
      `Variance is read-only once a run is approved/closed (current: ${payRun.closedAt ? 'CLOSED' : payRun.status})`,
    );
  }

  const curLines = await prisma.payRunLine.findMany({
    where: { businessId, payRunId },
    include: { components: { orderBy: { sortOrder: 'asc' } } },
  });

  // Prior period: same (entity, calendar, type), the highest sequence strictly
  // below this run's, that is at least COMPUTED.
  const prior = await prisma.payRun.findFirst({
    where: {
      businessId, entityId: payRun.entityId, payCalendarId: payRun.payCalendarId,
      type: payRun.type, deletedAt: null, id: { not: payRun.id },
      sequenceInYear: { lt: payRun.sequenceInYear },
      status: { in: ['COMPUTED', 'REVIEW', 'APPROVED', 'PAID', 'FILED'] },
    },
    orderBy: { sequenceInYear: 'desc' },
  });
  let prevPayload = null;
  if (prior) {
    const prevLines = await prisma.payRunLine.findMany({
      where: { businessId, payRunId: prior.id },
      include: { components: { orderBy: { sortOrder: 'asc' } } },
    });
    prevPayload = { runId: prior.id, lines: prevLines.map((l) => varianceLineFromRow(l)) };
  }
  const prevEmpIds = new Set((prevPayload ? prevPayload.lines : []).map((l) => l.employeeId));

  // One-time items flag arrear context for the downgrade.
  const oneTimeByEmp = new Set(
    (await prisma.payRunInputItem.findMany({ where: { businessId, payRunId }, select: { employeeId: true } }))
      .map((r) => r.employeeId),
  );

  const current = {
    runId: payRun.id, type: payRun.type,
    totalsMinor: { netMinor: decimalToMinor(payRun.totalNet) },
    lines: curLines.map((l) => varianceLineFromRow(l, {
      isNewJoiner: prevPayload ? !prevEmpIds.has(l.employeeId) : false,
      hasArrear: oneTimeByEmp.has(l.employeeId),
    })),
  };

  const thresholds = await resolveThresholds(businessId);
  const result = variance.runVarianceChecks({ current, previous: prevPayload, thresholds });

  const reportTotals = {
    current: {
      gross: decimalToMinor(payRun.totalGross), net: decimalToMinor(payRun.totalNet),
      deductions: decimalToMinor(payRun.totalDeductions), employerCost: decimalToMinor(payRun.totalEmployerCost),
      headcount: payRun.headcount,
    },
    previous: prior ? {
      gross: decimalToMinor(prior.totalGross), net: decimalToMinor(prior.totalNet),
      deductions: decimalToMinor(prior.totalDeductions), employerCost: decimalToMinor(prior.totalEmployerCost),
      headcount: prior.headcount,
    } : null,
  };

  // Persist: per-line VARIANCE findings to varianceJson (NOT errorJson — engine
  // anomalies own errorJson; keeping them separate means neither writer clobbers
  // the other's BLOCKERs, finding #7) + run-level varianceReport. We null
  // varianceJson when there are no findings so a recompute clears stale findings.
  const { byEmployee } = variance.findingsByEmployee(result.findings);
  await prisma.$transaction(async (tx) => {
    for (const line of curLines) {
      const findings = (byEmployee.get(line.employeeId) || []).filter(
        (f) => f.severity === 'BLOCKER' || f.severity === 'WARNING',
      );
      await tx.payRunLine.update({
        where: { id: line.id },
        data: { varianceJson: findings.length ? findings : null },
      });
    }
    await tx.payRun.update({
      where: { id: payRun.id },
      data: {
        varianceReport: {
          baselineRunId: prior ? prior.id : null,
          summary: result.summary,
          blockingAnomalies: result.blockingAnomalies,
          findings: result.findings,
          totals: reportTotals,
        },
      },
    });
  });

  return {
    payRunId, baselineRunId: prior ? prior.id : null,
    hasBaseline: !!prior, totals: reportTotals, ...result,
  };
}

/**
 * recountBlockers — sum BLOCKER findings from a DETERMINISTIC union of sources:
 * per-line ENGINE anomalies (errorJson) + per-line VARIANCE findings (varianceJson)
 * + the run-level varianceReport (e.g. RECONCILIATION_MISMATCH). The two per-line
 * columns are written by different stages (compute vs computeVariance) and NEVER
 * clobber each other, so the count no longer depends on call ordering (finding #7).
 */
async function recountBlockers(businessId, payRunId) {
  const lines = await prisma.payRunLine.findMany({
    where: { businessId, payRunId },
    select: { errorJson: true, varianceJson: true },
  });
  let blockers = 0;
  for (const l of lines) {
    const engine = Array.isArray(l.errorJson) ? l.errorJson : [];
    for (const e of engine) if (e && e.severity === 'BLOCKER') blockers += 1;
    const varns = Array.isArray(l.varianceJson) ? l.varianceJson : [];
    for (const v of varns) if (v && v.severity === 'BLOCKER') blockers += 1;
  }
  // Run-level (e.g. RECONCILIATION_MISMATCH) lives only in varianceReport.
  const run = await prisma.payRun.findFirst({ where: { id: payRunId, businessId }, select: { varianceReport: true } });
  const report = run && run.varianceReport;
  if (report && Array.isArray(report.findings)) {
    for (const f of report.findings) {
      if (f.severity === 'BLOCKER' && f.employeeId == null) blockers += 1;
    }
  }
  return blockers;
}

/** Stable hash of the run totals — what the checker reviews; STALE_TOTALS guard. */
function totalsHashOf(payRun) {
  return computeInputHash({
    inputs: {
      gross: String(payRun.totalGross), deductions: String(payRun.totalDeductions),
      net: String(payRun.totalNet), employerCost: String(payRun.totalEmployerCost),
      headcount: payRun.headcount, complianceVersionId: payRun.complianceVersionId || null,
    },
    ruleVersions: {}, engineVersion: ENGINE_VERSION,
  });
}

/**
 * submitRun — maker submits a COMPUTED run for review (COMPUTED→REVIEW). Guards
 * OPEN_BLOCKERS; records submittedBy + the totalsHash the checker will see.
 */
async function submitRun({ businessId, actorId, payRunId }) {
  const payRun = await loadRun(businessId, payRunId);
  if (payRun.status !== 'COMPUTED') throw badRequest('BAD_STATE', `Submit requires a COMPUTED run (current: ${payRun.status})`);

  // FAIL-CLOSED variance gate (finding #1): materialise the variance findings
  // FRESH from the current persisted lines here — do NOT rely on the operator
  // having hit the /variance endpoint first. Only then count blockers, so every
  // period-over-period BLOCKER the engine raises gates submit.
  await computeVariance({ businessId, payRunId });
  const blockingAnomalies = await recountBlockers(businessId, payRunId);

  const from = STATE.CALCULATED;
  const runState = { id: payRun.id, status: from, preparerId: payRun.computedBy || payRun.lockedBy, blockingAnomalies };
  transition(runState, STATE.IN_REVIEW, { actorId, blockingAnomalies });

  const totalsHash = totalsHashOf(payRun);
  await persistTransition({ prisma, payRunId, from, to: STATE.IN_REVIEW, ctx: { actorId, totalsHash } });
  await writeAudit({
    businessId, actorId, action: 'payrun.submit', entityType: 'PayRun', entityId: payRunId,
    meta: { code: payRun.code, blockingAnomalies, totalsHash },
  });
  return getRun({ businessId, payRunId });
}

/**
 * sendBackRun — checker returns a submitted run to the maker (REVIEW→COMPUTED).
 * Requires a reason; recorded for the audit trail. Checker must differ from the
 * submitter (a maker can't bounce their own submission to dodge the gate).
 */
async function sendBackRun({ businessId, actorId, payRunId, reason }) {
  const payRun = await loadRun(businessId, payRunId);
  if (payRun.status !== 'REVIEW') throw badRequest('BAD_STATE', `Send-back requires a REVIEW run (current: ${payRun.status})`);
  if (!reason || !String(reason).trim()) throw badRequest('MISSING_FIELDS', 'A send-back reason is required.');

  const from = STATE.IN_REVIEW;
  const runState = { id: payRun.id, status: from, preparerId: payRun.computedBy, submittedBy: payRun.submittedBy };
  transition(runState, STATE.CALCULATED, { actorId, reason });

  await persistTransition({ prisma, payRunId, from, to: STATE.CALCULATED, ctx: { actorId, reason } });
  await writeAudit({
    businessId, actorId, action: 'payrun.send_back', entityType: 'PayRun', entityId: payRunId,
    meta: { code: payRun.code, reason, submittedBy: payRun.submittedBy },
  });
  return getRun({ businessId, payRunId });
}

/**
 * publishRun — flip a run's payslips GENERATED→PUBLISHED and fire the publish
 * chain (payslip.published webhook + HR_PAYSLIP_PUBLISHED notification). Allowed
 * once the run is APPROVED/PAID (employees see a payslip only after publish).
 * Idempotent: already-PUBLISHED/VIEWED slips are left as-is.
 */
async function publishRun({ businessId, actorId, payRunId }) {
  const payRun = await loadRun(businessId, payRunId);
  if (!['APPROVED', 'PAID', 'FILED'].includes(payRun.status)) {
    throw badRequest('BAD_STATE', `Payslips can be published only after approval (current: ${payRun.status}).`);
  }
  const now = new Date();
  const updated = await prisma.payslip.updateMany({
    where: { businessId, payRunId, status: 'GENERATED', deletedAt: null },
    data: { status: 'PUBLISHED', publishedAt: now },
  });

  // Fire the publish chain per now-published slip (fire-and-forget; never blocks).
  const slips = await prisma.payslip.findMany({
    where: { businessId, payRunId, status: 'PUBLISHED', deletedAt: null },
    include: { employee: { select: { id: true, code: true, firstName: true, lastName: true, workEmail: true, personalEmail: true, phone: true } } },
  });
  for (const slip of slips) {
    webhooks.emitHrEvent(businessId, 'payslip.published', slip);
    const emp = slip.employee || {};
    notifications.notifyHrEvent({
      businessId, event: 'payslip.published',
      recipientEmail: emp.workEmail || emp.personalEmail || null,
      recipientPhone: emp.phone || null,
      variables: {
        NAME: [emp.firstName, emp.lastName].filter(Boolean).join(' ') || emp.code || 'there',
        PERIOD: `${isoDate(slip.periodStart)}–${isoDate(slip.periodEnd)}`,
        AMT: `${slip.currencyCode} ${slip.netPay}`,
        LINK: `/payslips/${slip.id}`,
        BIZ: 'DriftHR',
      },
      triggeredBy: actorId,
    }).catch(() => {});
  }

  await writeAudit({
    businessId, actorId, action: 'payrun.publish', entityType: 'PayRun', entityId: payRunId,
    meta: { code: payRun.code, published: updated.count },
  });
  return { payRunId, published: updated.count, total: slips.length };
}

/**
 * disburseRun — APPROVED→PAID via persistTransition; publishes payslips on the
 * disbursement boundary (employees see payslips only after PAID).
 */
async function disburseRun({ businessId, actorId, payRunId }) {
  const payRun = await loadRun(businessId, payRunId);
  if (payRun.status !== 'APPROVED') throw badRequest('BAD_STATE', `Disburse requires an APPROVED run (current: ${payRun.status})`);

  const runState = { id: payRun.id, status: STATE.APPROVED, payDate: isoDate(payRun.payDate) };
  transition(runState, STATE.PAID, { actorId, at: new Date() });
  await persistTransition({ prisma, payRunId, from: STATE.APPROVED, to: STATE.PAID, ctx: { actorId } });

  // Publish on the disbursement boundary.
  await publishRun({ businessId, actorId, payRunId });

  await writeAudit({
    businessId, actorId, action: 'payrun.pay', entityType: 'PayRun', entityId: payRunId,
    meta: { code: payRun.code, totalNet: String(payRun.totalNet) },
  });
  return getRun({ businessId, payRunId });
}

/** Map a country to the StatutoryRemittance rows + due dates its filings write. */
const FILING_PLAN = Object.freeze({
  IN: [
    // Monthly TDS deposit (Challan ITNS-281). The compliance generator emits a
    // monthly IN_TDS stub from the TAN obligation; without a matching fileRun
    // writer the stub was never reconciled and went auto-OVERDUE every month
    // (reminder spam). fileRun now stamps the run's TDS so the stub is reconciled
    // (real amount + DUE) on the SAME (entity, IN_TDS, "YYYY-MM") natural key.
    { kind: 'IN_TDS', fileKind: null, dueDom: 7, periodGranularity: 'month', tdsMarchSpecial: true },
    { kind: 'IN_PF', fileKind: 'ecr', dueDom: 15, periodGranularity: 'month' },
    { kind: 'IN_ESI', fileKind: 'esic', dueDom: 15, periodGranularity: 'month' },
    { kind: 'IN_PT', fileKind: null, dueDom: 20, periodGranularity: 'month', perState: 'pt' },
    // Feature 21 — Labour Welfare Fund. NOT monthly-uniform: due-date/taxPeriod
    // depend on the state frequency (half-yearly/annual/monthly), resolved by the
    // 'lwf' branch below. Conditional: only fires (and is required to close) in the
    // state's prescribed deduction month(s); skipped when the run has 0 LWF incidence.
    { kind: 'IN_LWF', fileKind: null, periodGranularity: 'lwf', conditional: true, perState: 'lwf' },
    { kind: 'IN_FORM24Q', fileKind: 'form24q', dueDom: 31, periodGranularity: 'quarter' },
  ],
  NZ: [
    { kind: 'NZ_PAYDAY_FILING', fileKind: 'ei', dueWorkingDays: 2, periodGranularity: 'payday' },
    { kind: 'NZ_PAYE', fileKind: null, dueDom: 20, periodGranularity: 'month' },
  ],
});

/**
 * resolveFilingPlan — return the filing obligations for a SUPPORTED country, or
 * throw COUNTRY_MISMATCH for an UNKNOWN one (finding #6). This distinguishes a
 * supported country with an intentionally-empty plan from an unconfigured/third
 * country — the latter must NOT silently file nothing and close clean.
 */
function resolveFilingPlan(country) {
  const plan = FILING_PLAN[country];
  if (plan === undefined) {
    throw badRequest(
      'COUNTRY_MISMATCH',
      `No statutory filing plan for country "${country}". Supported: ${Object.keys(FILING_PLAN).join(', ')}.`,
    );
  }
  return plan;
}

/**
 * Feature 21 — resolve the LWF frequency for a run's state (the run's entity
 * state via the india read model). Half-yearly/annual/monthly drive the LWF
 * due-date and taxPeriod. Falls back to MONTHLY if the state is unmapped (the
 * row is only written when LWF actually fired, so this is a safe default).
 */
function lwfFrequencyForRun(payRun) {
  const stateCode = payRun.lwfStateCode
    || (payRun.entity && payRun.entity.stateCode)
    || null;
  if (!stateCode) return 'MONTHLY';
  const r = india.resolveLwf(stateCode, isoDate(payRun.periodEnd));
  return (r && r.configured && r.frequency) ? r.frequency : 'MONTHLY';
}

/** Compute a due date (Date) for a remittance kind from the run period. */
function remittanceDueDate(plan, payRun) {
  const end = new Date(isoDate(payRun.periodEnd) + 'T00:00:00Z');
  if (plan.periodGranularity === 'quarter') {
    // 24Q/138: filed `offset` months after the fiscal quarter's LAST month.
    //   Q1-Q3 → +1 month (e.g. Q1 ends Jun → 31 Jul).
    //   Q4    → +2 months (ends 31 Mar → 31 MAY, NOT 31 Apr). A +1 month with
    //           dueDom 31 overflowed into 1-May → a premature OVERDUE and a
    //           divergence from the compliance generator's 31-May. Match it here.
    const isQ4 = end.getUTCMonth() + 1 === 3; // fiscal Q4 ends in March
    const offsetMonths = isQ4 ? 2 : 1;
    return new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + offsetMonths, plan.dueDom || 31));
  }
  if (plan.periodGranularity === 'lwf') {
    // LWF: half-yearly states remit by the 15th of the month after the half just
    // closed (15 Jul for the Jun run / 15 Jan for the Dec run); annual by 15 Jan;
    // monthly by the 15th of the next month. End-month already encodes the half.
    const freq = lwfFrequencyForRun(payRun);
    if (freq === 'HALF_YEARLY' || freq === 'ANNUAL') {
      // Jun (month 5, 0-based) → 15 Jul; Dec (month 11) → 15 Jan next year.
      return new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 15));
    }
    return new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 15));
  }
  if (plan.dueWorkingDays != null) {
    const d = new Date(isoDate(payRun.payDate) + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + plan.dueWorkingDays + 2); // pad weekends
    return d;
  }
  // Monthly TDS March-wage special: TDS for the MARCH wage month is due 30 Apr
  // (one extra month vs the usual 7th), matching the generator's specialRules
  // {marchDueDom:30}. Without it the March stub diverged + went early-OVERDUE.
  if (plan.tdsMarchSpecial && end.getUTCMonth() + 1 === 3) {
    return new Date(Date.UTC(end.getUTCFullYear(), 3 /* Apr, 0-based */, 30));
  }
  // Monthly: dueDom of the month FOLLOWING the period.
  return new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, plan.dueDom || 15));
}

/** taxPeriod string for a remittance: "YYYY-MM", "YYYY-Qn", or an LWF label. */
function remittanceTaxPeriod(plan, payRun) {
  if (plan.periodGranularity === 'quarter') {
    return `${payRun.taxYear}-${indianQuarter(payRun.periodEnd)}`;
  }
  if (plan.periodGranularity === 'lwf') {
    // Half-yearly => "YYYY-H1"/"YYYY-H2"; annual => "YYYY"; monthly => "YYYY-MM".
    const freq = lwfFrequencyForRun(payRun);
    const end = new Date(isoDate(payRun.periodEnd) + 'T00:00:00Z');
    const y = end.getUTCFullYear();
    const m = end.getUTCMonth() + 1; // 1..12
    if (freq === 'HALF_YEARLY') return `${y}-${m <= 6 ? 'H1' : 'H2'}`;
    if (freq === 'ANNUAL') return `${y}`;
    return isoDate(payRun.periodStart).slice(0, 7);
  }
  return isoDate(payRun.periodStart).slice(0, 7);
}

/**
 * remittanceKind — the EFFECTIVE remittance kind for the run's period, applying
 * the Income Tax Act 2025 succession (IN_FORM24Q → IN_FORM138 for periods ENDING
 * on/after 2026-04-01) via the SAME resolver the compliance generator uses. This
 * is what keeps fileRun() and calendarRunner on ONE natural key — without it the
 * generator wrote IN_FORM138 while fileRun wrote IN_FORM24Q for the same quarter,
 * leaving a permanent duplicate + perpetual false-overdue. Kinds with no successor
 * (PF/ESI/PT/LWF/TDS) pass through unchanged.
 */
function remittanceKind(plan, payRun) {
  const succ = DEFAULT_SUCCESSOR[plan.kind];
  if (!succ) return plan.kind;
  const ob = { kind: plan.kind, specialRules: { successorKind: succ.kind, successorFrom: succ.from } };
  return resolveKindForPeriod(ob, new Date(isoDate(payRun.periodEnd) + 'T00:00:00Z'));
}

/**
 * remittanceStateCode — the per-state code a PT/LWF row is keyed on, so fileRun's
 * row shares the natural key with the generator's per-state stub (no duplicate).
 * PT keys on the run/entity PT state; LWF on the run's LWF state. Entity-wide
 * kinds (PF/ESI/TDS/24Q) have no stateCode.
 */
function remittanceStateCode(plan, payRun) {
  if (plan.perState === 'pt') {
    return payRun.ptStateCode || (payRun.entity && payRun.entity.stateCode) || null;
  }
  if (plan.perState === 'lwf') {
    return payRun.lwfStateCode || (payRun.entity && payRun.entity.stateCode) || null;
  }
  return null;
}

/**
 * fileRun — PAID→FILED; write a StatutoryRemittance row per country filing
 * obligation, idempotent on the natural key (businessId, entityId, kind,
 * taxPeriod, stateCode). Uses persistTransition.
 */
async function fileRun({ businessId, actorId, payRunId }) {
  const payRun = await loadRun(businessId, payRunId, true);
  if (payRun.status !== 'PAID') throw badRequest('BAD_STATE', `Filing requires a PAID run (current: ${payRun.status})`);
  const country = payRun.entity.countryCode;
  // Reject an unsupported country (finding #6) rather than filing nothing silently.
  const plan = resolveFilingPlan(country);

  const lines = await prisma.payRunLine.findMany({ where: { businessId, payRunId } });
  const sumDec = (field) => lines.reduce((s, l) => s + decimalToMinor(l[field]), 0);
  const amountForKind = (kind) => {
    switch (kind) {
      case 'IN_PF': return sumDec('pfEmployee') + sumDec('pfEmployer');
      case 'IN_ESI': return sumDec('esiEmployee') + sumDec('esiEmployer');
      case 'IN_PT': return sumDec('pt');
      case 'IN_LWF': return sumDec('lwfEmployee') + sumDec('lwfEmployer');
      case 'IN_TDS': return sumDec('tds');
      case 'IN_FORM24Q': return sumDec('tds');
      case 'IN_FORM138': return sumDec('tds'); // 24Q successor (same TDS-salary base)
      case 'NZ_PAYE': return sumDec('paye') + sumDec('esct');
      case 'NZ_PAYDAY_FILING': return sumDec('paye') + sumDec('kiwiSaverEmployee') + sumDec('kiwiSaverEmployer');
      default: return 0;
    }
  };

  const transitionState = { id: payRun.id, status: STATE.PAID };
  transition(transitionState, STATE.FILED, { actorId, at: new Date() });

  const written = [];
  await prisma.$transaction(async (tx) => {
    await persistTransition({ prisma: tx, payRunId, from: STATE.PAID, to: STATE.FILED, ctx: { actorId } });
    for (const p of plan) {
      const amountMinor = amountForKind(p.kind);
      // Feature 21 — zero-incidence skip: a CONDITIONAL plan entry (LWF) is only
      // written in a deduction month with real incidence. Don't pollute the
      // compliance calendar (or trip closeRun's guard) with a phantom ₹0 LWF row.
      if (p.conditional && amountMinor === 0) continue;
      // Resolve the EFFECTIVE kind (24Q→138 succession) + per-state code so the row
      // shares the EXACT natural key the compliance generator writes — one row per
      // (entity, kind, taxPeriod, stateCode), never a duplicate vs the calendar.
      const kind = remittanceKind(p, payRun);
      const taxPeriod = remittanceTaxPeriod(p, payRun);
      const stateCode = remittanceStateCode(p, payRun);
      const existing = await tx.statutoryRemittance.findFirst({
        where: { businessId, entityId: payRun.entityId, kind, taxPeriod, stateCode },
      });
      const fileUrl = p.fileKind ? `/api/hr/payroll/runs/${payRunId}/files/${p.fileKind}` : null;
      const data = {
        businessId, entityId: payRun.entityId, payRunId,
        kind, taxPeriod, stateCode, amount: toDec(amountMinor), currencyCode: payRun.currencyCode,
        dueDate: remittanceDueDate(p, payRun), status: 'DUE', fileUrl,
        meta: { fileKind: p.fileKind, granularity: p.periodGranularity, runCode: payRun.code },
      };
      if (existing) {
        await tx.statutoryRemittance.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } });
        written.push({ kind, taxPeriod, id: existing.id });
      } else {
        const row = await tx.statutoryRemittance.create({ data });
        written.push({ kind, taxPeriod, id: row.id });
      }
    }
  });

  await writeAudit({
    businessId, actorId, action: 'payrun.file', entityType: 'PayRun', entityId: payRunId,
    meta: { code: payRun.code, country, remittances: written.map((w) => w.kind) },
  });
  return { payRunId, country, remittances: written };
}

/**
 * closeRun — FILED→FILED+closedAt. Guarded: every due StatutoryRemittance for the
 * period must exist before a run can be closed (no quietly-skipped filing).
 */
async function closeRun({ businessId, actorId, payRunId }) {
  const payRun = await loadRun(businessId, payRunId, true);
  if (payRun.status !== 'FILED') throw badRequest('BAD_STATE', `Close requires a FILED run (current: ${payRun.status})`);
  if (payRun.closedAt) return getRun({ businessId, payRunId }); // already closed → idempotent

  const country = payRun.entity.countryCode;
  // Reject an unsupported country (finding #6) — its "no missing remittances"
  // close guard would otherwise be vacuously satisfied (plan = []).
  const plan = resolveFilingPlan(country);
  const remittances = await prisma.statutoryRemittance.findMany({ where: { businessId, payRunId } });
  const haveKinds = new Set(remittances.map((r) => r.kind));
  // Feature 21 — a CONDITIONAL plan entry (LWF) is only required to exist when the
  // run had real incidence in a deduction month. A non-deduction-month run (₹0 LWF)
  // legitimately writes no IN_LWF row and must still close clean; only enforce the
  // conditional kind when its summed amount is non-zero.
  let lwfIncidenceMinor = null;
  const condIncidence = async (kind) => {
    if (kind !== 'IN_LWF') return 0;
    if (lwfIncidenceMinor == null) {
      const lines = await prisma.payRunLine.findMany({ where: { businessId, payRunId } });
      lwfIncidenceMinor = lines.reduce(
        (s, l) => s + decimalToMinor(l.lwfEmployee) + decimalToMinor(l.lwfEmployer), 0,
      );
    }
    return lwfIncidenceMinor;
  };
  const missing = [];
  for (const p of plan) {
    // fileRun writes the EFFECTIVE kind (24Q→138 succession) — check for THAT, not
    // the static plan family, or a post-2026 run would falsely look "missing 24Q".
    const effKind = remittanceKind(p, payRun);
    if (haveKinds.has(effKind)) continue;
    if (p.conditional && (await condIncidence(p.kind)) === 0) continue; // no incidence → not required
    missing.push(effKind);
  }
  if (missing.length) {
    throw badRequest('CLOSE_BLOCKED', `Cannot close — missing remittances: ${missing.join(', ')}. File the run first.`);
  }

  const runState = { id: payRun.id, status: STATE.FILED };
  transition(runState, STATE.CLOSED, { actorId, at: new Date() });
  // CLOSED maps to prisma FILED; persistTransition sets closedAt.
  await persistTransition({ prisma, payRunId, from: STATE.FILED, to: STATE.CLOSED, ctx: { actorId } });

  await writeAudit({
    businessId, actorId, action: 'payrun.close', entityType: 'PayRun', entityId: payRunId,
    meta: { code: payRun.code },
  });
  return getRun({ businessId, payRunId });
}

/** cancelRun — →CANCELLED (pre-approval only; else CANNOT_CANCEL). */
async function cancelRun({ businessId, actorId, payRunId, reason }) {
  const payRun = await loadRun(businessId, payRunId);
  const from = engineStateOf(payRun);
  if (['APPROVED', 'PAID', 'FILED'].includes(payRun.status) || payRun.closedAt) {
    throw badRequest('CANNOT_CANCEL', 'Cannot cancel after APPROVED; create a compensating CORRECTION run.');
  }
  const runState = { id: payRun.id, status: from };
  transition(runState, STATE.CANCELLED, { actorId, reason });
  await persistTransition({ prisma, payRunId, from, to: STATE.CANCELLED, ctx: { actorId, reason } });
  // Cycle-0 — a cancelled run that had already computed must release its loan stamps
  // (installments → PENDING, Loan running totals reversed) so a later run can recover
  // them. No-op when the run was cancelled before it ever computed.
  await loanRecovery.unwindForRun(prisma, { businessId, payRunId });
  // Feature 26 (FLAGGED) — likewise release any reimbursement claims this run stamped
  // (REIMBURSED → APPROVED, payRunId/paidViaPayrollAmount cleared) so the next regular
  // run pays them. No-op when the run never computed / paid no reimbursements.
  await reimbursementPayout.unwindForRun(prisma, { businessId, payRunId });
  await writeAudit({
    businessId, actorId, action: 'payrun.cancel', entityType: 'PayRun', entityId: payRunId,
    meta: { code: payRun.code, reason: reason || null, from: payRun.status },
  });
  return getRun({ businessId, payRunId });
}

/**
 * reopenRun — INPUTS_LOCKED/COMPUTED/REVIEW → DRAFT (editable again); clears the
 * compute fingerprint. Post-approval reopen is refused (CANNOT_REOPEN).
 */
async function reopenRun({ businessId, actorId, payRunId }) {
  const payRun = await loadRun(businessId, payRunId);
  if (['APPROVED', 'PAID', 'FILED'].includes(payRun.status) || payRun.closedAt) {
    throw badRequest('CANNOT_REOPEN', 'Cannot reopen after APPROVED; create a CORRECTION run.');
  }
  if (!['INPUTS_LOCKED', 'COMPUTED', 'REVIEW'].includes(payRun.status)) {
    throw badRequest('BAD_STATE', `Nothing to reopen from ${payRun.status}.`);
  }
  // REVIEW reopens to DRAFT through COMPUTED's edge (REVIEW→COMPUTED is send-back,
  // then COMPUTED→DRAFT). Model directly: the prisma status moves to DRAFT.
  const from = engineStateOf(payRun);
  // INPUTS_LOCKED/CALCULATED have a direct →DRAFT edge; IN_REVIEW does not, so bounce.
  if (from === STATE.IN_REVIEW) {
    // REVIEW→COMPUTED (send-back to self as reopen) then COMPUTED→DRAFT.
    await persistTransition({ prisma, payRunId, from: STATE.IN_REVIEW, to: STATE.CALCULATED, ctx: { actorId, reason: 'reopen' } });
    await persistTransition({ prisma, payRunId, from: STATE.CALCULATED, to: STATE.DRAFT, ctx: { actorId } });
  } else {
    const runState = { id: payRun.id, status: from };
    transition(runState, STATE.DRAFT, { actorId });
    await persistTransition({ prisma, payRunId, from, to: STATE.DRAFT, ctx: { actorId } });
  }
  // Clear compute artefacts (lines/components/payslips/variance) so a recompute is clean.
  await prisma.$transaction(async (tx) => {
    await tx.payslip.deleteMany({ where: { businessId, payRunId } });
    await tx.payRunLineComponent.deleteMany({ where: { payRunLine: { payRunId } } });
    await tx.payRunLine.deleteMany({ where: { payRunId } });
    // Cycle-0 — unwind any loan stamps this run wrote (installments → PENDING, Loan
    // running totals reversed) so reopening cleanly undoes the recovery. A later
    // recompute re-selects the now-PENDING installments.
    await loanRecovery.unwindForRun(tx, { businessId, payRunId });
    // Feature 26 (FLAGGED) — release any reimbursement claims this run stamped
    // (REIMBURSED → APPROVED, payRunId/paidViaPayrollAmount cleared) so reopening
    // cleanly undoes the payout; a later recompute re-selects the now-APPROVED claims.
    await reimbursementPayout.unwindForRun(tx, { businessId, payRunId });
    await tx.payRun.update({
      where: { id: payRunId },
      data: { varianceReport: null, totalsHash: null, headcount: 0, totalGross: 0, totalDeductions: 0, totalNet: 0, totalEmployerCost: 0 },
    });
  });
  await writeAudit({
    businessId, actorId, action: 'payrun.reopen', entityType: 'PayRun', entityId: payRunId,
    meta: { code: payRun.code, from: payRun.status },
  });
  return getRun({ businessId, payRunId });
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

  // The NZ direct-credit batch needs the employee's PRIMARY bank account. Load
  // them up-front (tenant-scoped) and pass them into the aggregate builder so we
  // emit REAL accounts and can pre-validate, instead of always sending null.
  let bankByEmployee = null;
  if (spec.country === 'NZ' && spec.fn === 'generateBankBatch') {
    const employeeIds = lines.map((l) => l.employeeId).filter(Boolean);
    const accounts = employeeIds.length
      ? await prisma.bankAccount.findMany({
          where: { businessId, employeeId: { in: employeeIds }, isActive: true, deletedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          select: { employeeId: true, nzBankAccount: true, accountNumber: true, isPrimary: true },
        })
      : [];
    bankByEmployee = new Map();
    for (const a of accounts) {
      // First match wins (primary first by ordering); don't clobber.
      if (!bankByEmployee.has(a.employeeId)) {
        bankByEmployee.set(a.employeeId, a.nzBankAccount || a.accountNumber || null);
      }
    }
  }

  const aggregate = buildFilingAggregate(payRun, lines, spec.country, { bankByEmployee });

  // Fail-closed pre-validation for the bank batch: rather than let the pure
  // generator throw a bare RangeError mid-loop (→ 500), collect EVERY offender
  // and return a structured 422 MISSING_BANK_DETAILS the operator can act on.
  if (spec.fn === 'generateBankBatch') {
    const issues = filing.newzealand.collectBankBatchIssues(aggregate);
    if (issues.length) {
      const e = badRequest(
        'MISSING_BANK_DETAILS',
        `${issues.length} employee(s) cannot be paid: fix bank details, then re-export.`,
      );
      e.statusCode = 422;
      e.offenders = issues;
      throw e;
    }
  }

  const gen = filing[spec.country === 'IN' ? 'india' : 'newzealand'][spec.fn];
  return gen(aggregate);
}

/** Assemble the pure filing aggregate (integer minor units) from persisted rows. */
function buildFilingAggregate(payRun, lines, country, opts = {}) {
  const bankByEmployee = opts.bankByEmployee || null;
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
          // Read the ACTUAL persisted statutory wage bases (finding #5). NEVER
          // back-derive the wage by dividing the contribution by a hardcoded rate
          // (float reconstruction corrupts paise once the wage is capped / on full
          // wage / VPF-adjusted). pfWagesBase/epsWagesBase/edliWagesBase are written
          // at compute time straight from the engine-derived bases.
          epfWagesMinor: decimalToMinor(l.pfWagesBase),
          epsWagesMinor: decimalToMinor(l.epsWagesBase),
          edliWagesMinor: decimalToMinor(l.edliWagesBase),
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
          code: l.employee ? l.employee.code : null,
          irdNumber: sp.irdNumber || '',
          taxCode: sp.taxCode || '',
          bankAccount: bankByEmployee ? (bankByEmployee.get(l.employeeId) || null) : null,
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
  getMyPayslipPdfContext,
  getPayslipPdfContext,
  recordPayslipPdfHash,
  generateFile,
  // Feature 7 — run orchestration / lifecycle past APPROVED
  listRunEntities,
  getInputsChecklist,
  upsertOneTimeInput,
  computeVariance,
  submitRun,
  sendBackRun,
  publishRun,
  disburseRun,
  fileRun,
  closeRun,
  cancelRun,
  reopenRun,
  recountBlockers,
  // ESS self-resolution (reused by the compensation ESS route).
  resolveSelfEmployee,
  // internals exposed for tests
  _internal: {
    taxYearFor, buildFilingAggregate, statutoryRollups, buildPayslipSnapshot,
    resolveCurrentCompensation, resolveBalancingTarget, varianceLineFromRow,
    totalsHashOf, remittanceDueDate, remittanceTaxPeriod, remittanceKind, remittanceStateCode, FILING_PLAN,
    resolveFourEyesPolicy, resolveFilingPlan,
    buildLopProvenance, // F16 — payslip LOP provenance (LOW#1 phantom-line guard)
  },
};
