'use strict';

/**
 * engine.js — country-agnostic payroll calculation core.
 *
 * PURE: no DB, no I/O, no prisma, no Date.now in the math. Unit-testable with
 * plain `node` to the exact paise/cent. The ONLY delegation point is
 * complianceModule.compute() (the statutory plug-in seam, §9 of docs/04).
 *
 * The engine:
 *   1. resolves the component set + per-employee inputs,
 *   2. computes the proration / LOP multiplier,
 *   3. evaluates EARNINGS (with proration & LOP behaviour),
 *   4. derives periodGross / basic and the statutory wage flags,
 *   5. calls complianceModule.compute() for employee deductions + employer
 *      contributions + anomalies,
 *   6. evaluates VOLUNTARY deductions (with a negative-net guard),
 *   7. aggregates gross / deductions / employer cost / NET,
 *   8. emits an explain[] trace.
 *
 * The core NEVER hard-codes "EPF"/"PAYE"/etc.; statutory behaviour is entirely
 * the compliance module's. The core only knows components, bases, proration,
 * and the result graph.
 */

const money = require('./money');
const { RoundingMode } = money;

// Component categories the engine recognises (aligned with schema ComponentCategory
// plus the statutory/voluntary split the engine needs internally).
const CATEGORY = Object.freeze({
  EARNING: 'EARNING',
  DEDUCTION: 'DEDUCTION', // voluntary, employee-side (loans, advances, NPS...)
  EMPLOYER_COST: 'EMPLOYER_COST',
  REIMBURSEMENT: 'REIMBURSEMENT',
});

// Proration policies (mirror docs/04 §6.1 + schema ProrationMethod).
const PRORATION = Object.freeze({
  CALENDAR_DAYS: 'CALENDAR_DAYS', // standardDays = calendar days in period
  WORKING_DAYS: 'WORKING_DAYS', // standardDays = working days in period
  FIXED_30: 'FIXED_30',
  FIXED_26: 'FIXED_26',
  NONE: 'NONE', // never prorated (FIXED_REGARDLESS)
});

// LOP behaviour per component.
const LOP_BEHAVIOR = Object.freeze({
  REDUCES_WITH_LOP: 'REDUCES_WITH_LOP',
  FIXED_REGARDLESS: 'FIXED_REGARDLESS',
});

// calcMethod for earning/voluntary components the engine evaluates itself.
// (STATUTORY components are NOT evaluated here — they come from the module.)
const CALC = Object.freeze({
  FIXED: 'FIXED',
  PERCENT_OF_BASE: 'PERCENT_OF_BASE',
  ATTENDANCE_DRIVEN: 'ATTENDANCE_DRIVEN', // e.g. OT = otHours * ratePerHourMinor
  BALANCE_RECOVERY: 'BALANCE_RECOVERY',
});

/**
 * computePayslip — the engine entry point.
 *
 * @param {Object}   args
 * @param {Array}    args.components   component definitions for this employee:
 *        {
 *          code, name, category,            // CATEGORY.*
 *          calcMethod,                      // CALC.*
 *          amountMinor?,                    // FIXED
 *          percent?, baseCode?, ofBase?,    // PERCENT_OF_BASE
 *          ratePerHourMinor?, hoursField?,  // ATTENDANCE_DRIVEN
 *          floorMinor?, capMinor?,
 *          prorationPolicy,                 // PRORATION.*
 *          lopBehavior,                     // LOP_BEHAVIOR.*
 *          roundMode?,                      // RoundingMode.* (default HALF_UP)
 *          // statutory wage flags (drive the bases handed to the module):
 *          isBasic?, isPfWages?, isEsiWages?, isPtWages?, isGratuityWages?,
 *          isNzGrossEarnings?, isPayeable?, isKiwiSaverable?, isTaxable?,
 *          showOnPayslip?
 *        }
 * @param {Object}   args.inputs       { lopDays, payableDays?, standardDays?,
 *                                        otHours?, calendarDays?, workingDays?, ... }
 * @param {Object}   args.complianceModule  the resolved IN/NZ module (pure)
 * @param {Object}   args.ytd          year-to-date state passed through to the module
 * @param {Object}   args.period       { start, end, payDate, frequency, fiscalYear }
 * @param {Object}  [args.employee]    statutory context passed to the module
 * @param {Object}  [args.entity]      entity context passed to the module
 * @param {String}  [args.currencyCode]
 *
 * @returns {Object} {
 *   earnings:               [{ code, label, amountMinor, baseMinor?, explain }],
 *   grossMinor,
 *   reimbursements:         [{ code, label, amountMinor }],
 *   employeeDeductions:     [{ code, label, amountMinor, explain, statutory }],
 *   employerContributions:  [{ code, label, amountMinor, explain }],
 *   totalEmployeeDeductionsMinor,
 *   totalEmployerContributionsMinor,
 *   netMinor,
 *   bases:                  { periodGrossMinor, basicMinor, pfWagesMinor, ... },
 *   anomalies:              [{ code, severity, message }],
 *   explain:                [TraceNode],
 * }
 */
function computePayslip(args) {
  const {
    components,
    inputs = {},
    complianceModule,
    ytd = {},
    period = {},
    employee = {},
    entity = {},
    currencyCode,
  } = args || {};

  if (!Array.isArray(components)) {
    throw new TypeError('computePayslip: components must be an array');
  }
  if (!complianceModule || typeof complianceModule.compute !== 'function') {
    throw new TypeError('computePayslip: complianceModule with compute() is required');
  }

  const explain = [];
  const trace = (node) => {
    explain.push(node);
    return node;
  };

  // ── 1. Proration / LOP multiplier ──────────────────────────────────────────
  const proration = resolveProration(inputs, period, trace);

  // ── 2. Partition components ────────────────────────────────────────────────
  const earningDefs = [];
  const voluntaryDefs = [];
  const reimbursementDefs = [];
  for (const c of components) {
    switch (c.category) {
      case CATEGORY.EARNING:
        earningDefs.push(c);
        break;
      case CATEGORY.DEDUCTION:
        voluntaryDefs.push(c); // voluntary employee deductions (engine-evaluated)
        break;
      case CATEGORY.REIMBURSEMENT:
        reimbursementDefs.push(c);
        break;
      case CATEGORY.EMPLOYER_COST:
        // Non-statutory employer costs (rare; gratuity provision etc.) flow
        // through as employer contributions but are not in net pay.
        voluntaryDefs.push(c); // handled by category check below
        break;
      default:
        throw new RangeError(
          `computePayslip: component ${c.code} has unknown category ${c.category}`
        );
    }
  }

  // ── 3. Evaluate EARNINGS (two passes: literals first, then PERCENT_OF_BASE) ─
  const earningByCode = new Map();
  const earnings = [];

  // First pass: FIXED + ATTENDANCE_DRIVEN (no dependency on other components).
  for (const def of earningDefs) {
    if (def.calcMethod === CALC.PERCENT_OF_BASE) continue;
    const r = evalEarning(def, { proration, inputs, earningByCode }, trace);
    earningByCode.set(def.code, r.amountMinor);
    earnings.push(r);
  }
  // Second pass: PERCENT_OF_BASE (may reference first-pass earnings or GROSS).
  for (const def of earningDefs) {
    if (def.calcMethod !== CALC.PERCENT_OF_BASE) continue;
    const r = evalEarning(def, { proration, inputs, earningByCode }, trace);
    earningByCode.set(def.code, r.amountMinor);
    earnings.push(r);
  }
  // Restore declared order for output stability.
  earnings.sort((a, b) => a._order - b._order);
  for (const e of earnings) delete e._order;

  const grossMinor = money.sumMinor(earnings.map((e) => e.amountMinor));
  trace({
    op: 'BASE_SUM',
    base: 'GROSS_EARNED',
    inputs: earnings.map((e) => ({ ref: e.code, amountMinor: e.amountMinor })),
    outputMinor: grossMinor,
    note: 'Gross earned = Σ earnings after proration & LOP',
  });

  // ── 4. Build statutory bases from flags (name-agnostic, §3.3 / §8.1) ───────
  const basicMinor = sumFlagged(earnings, earningByCode, earningDefs, (d) => d.isBasic);
  const pfWagesFlaggedMinor = sumFlagged(earnings, earningByCode, earningDefs, (d) => d.isPfWages);
  const esiWagesMinor = sumFlagged(earnings, earningByCode, earningDefs, (d) => d.isEsiWages);
  const ptWagesMinor = sumFlagged(earnings, earningByCode, earningDefs, (d) => d.isPtWages);
  const gratuityWagesMinor = sumFlagged(earnings, earningByCode, earningDefs, (d) => d.isGratuityWages);
  const nzGrossEarningsMinor = sumFlagged(earnings, earningByCode, earningDefs, (d) => d.isNzGrossEarnings);
  const payeableMinor = sumFlagged(earnings, earningByCode, earningDefs, (d) => d.isPayeable !== false && d.isTaxable !== false);
  const ksGrossMinor = sumFlagged(earnings, earningByCode, earningDefs, (d) => d.isKiwiSaverable);
  const taxableMinor = sumFlagged(earnings, earningByCode, earningDefs, (d) => d.isTaxable !== false);

  const bases = {
    periodGrossMinor: grossMinor,
    basicMinor,
    pfWagesFlaggedMinor,
    esiWagesMinor,
    ptWagesMinor,
    gratuityWagesMinor,
    nzGrossEarningsMinor,
    payeableMinor,
    ksGrossMinor,
    taxableMinor,
  };
  trace({
    op: 'BASE_SUM',
    base: 'STATUTORY_BASES',
    outputMinor: grossMinor,
    params: { ...bases },
    note: 'Statutory wage bases derived from component flags (not names)',
  });

  // ── 5. Delegate statutory computation to the country module (the seam) ─────
  const statResult = complianceModule.compute({
    periodGrossMinor: grossMinor,
    basicMinor,
    components: componentSnapshotForModule(earnings, earningByCode, earningDefs),
    bases,
    ytd,
    period,
    employee,
    entity,
  }) || {};

  const employeeDeductions = [];
  const employerContributions = [];
  const anomalies = Array.isArray(statResult.anomalies) ? statResult.anomalies.slice() : [];

  for (const d of statResult.employeeDeductions || []) {
    money.assertMinor(d.amountMinor, `statutory deduction ${d.code}`);
    employeeDeductions.push({
      code: d.code,
      label: d.label || d.code,
      amountMinor: d.amountMinor,
      explain: d.explain || null,
      statutory: true,
    });
    trace({
      op: 'STATUTORY',
      componentCode: d.code,
      outputMinor: d.amountMinor,
      note: d.explain || `${d.code} (statutory deduction)`,
    });
  }
  for (const c of statResult.employerContributions || []) {
    money.assertMinor(c.amountMinor, `employer contribution ${c.code}`);
    employerContributions.push({
      code: c.code,
      label: c.label || c.code,
      amountMinor: c.amountMinor,
      explain: c.explain || null,
    });
    trace({
      op: 'STATUTORY',
      componentCode: c.code,
      outputMinor: c.amountMinor,
      note: c.explain || `${c.code} (employer contribution)`,
    });
  }

  // ── 6. VOLUNTARY deductions + non-statutory employer costs ─────────────────
  // Running net floor guard: voluntary recoveries cannot push net below 0.
  const statEeTotal = money.sumMinor(employeeDeductions.map((d) => d.amountMinor));
  let netSoFar = money.subMinor(grossMinor, statEeTotal);

  for (const def of voluntaryDefs) {
    if (def.category === CATEGORY.EMPLOYER_COST) {
      const amt = evalSimple(def, { proration, grossMinor, earningByCode }, trace);
      employerContributions.push({
        code: def.code,
        label: def.name || def.code,
        amountMinor: amt,
        explain: def.explain || null,
      });
      continue;
    }
    let amt = evalSimple(def, { proration, grossMinor, earningByCode }, trace);
    // Negative-net guard for recoveries: clamp to available net, flag the rest.
    if (def.calcMethod === CALC.BALANCE_RECOVERY && amt > netSoFar) {
      const capped = Math.max(netSoFar, 0);
      if (capped < amt) {
        anomalies.push({
          code: 'RECOVERY_CAPPED_TO_NET',
          severity: 'WARNING',
          message: `${def.code}: recovery ${money.fromMinor(amt)} exceeds available net ${money.fromMinor(capped)}; residual carried forward`,
        });
      }
      amt = capped;
    }
    employeeDeductions.push({
      code: def.code,
      label: def.name || def.code,
      amountMinor: amt,
      explain: def.explain || null,
      statutory: false,
    });
    netSoFar = money.subMinor(netSoFar, amt);
  }

  // ── 7. Reimbursements (claim-bounded; not wages; not in statutory bases) ────
  const reimbursements = reimbursementDefs.map((def) => {
    const amt = evalSimple(def, { proration, grossMinor, earningByCode }, trace);
    return { code: def.code, label: def.name || def.code, amountMinor: amt };
  });

  // ── 8. Aggregate ───────────────────────────────────────────────────────────
  const totalEmployeeDeductionsMinor = money.sumMinor(
    employeeDeductions.map((d) => d.amountMinor)
  );
  const totalEmployerContributionsMinor = money.sumMinor(
    employerContributions.map((c) => c.amountMinor)
  );
  const reimbTotalMinor = money.sumMinor(reimbursements.map((r) => r.amountMinor));

  // Net pay = gross − employee deductions (+ reimbursements paid through payroll).
  let netMinor = money.subMinor(grossMinor, totalEmployeeDeductionsMinor);
  netMinor = netMinor + reimbTotalMinor;
  money.assertMinor(netMinor, 'net');

  trace({
    op: 'BASE_SUM',
    base: 'NET_PAY',
    inputs: [
      { ref: 'GROSS_EARNED', amountMinor: grossMinor },
      { ref: 'EE_DEDUCTIONS', amountMinor: -totalEmployeeDeductionsMinor },
      { ref: 'REIMBURSEMENTS', amountMinor: reimbTotalMinor },
    ],
    outputMinor: netMinor,
    note: 'Net = gross − Σ employee deductions + reimbursements',
  });

  // Negative-net is a BLOCKER anomaly (engine surfaces; caller gates at VALIDATED).
  if (netMinor < 0) {
    anomalies.push({
      code: 'NEGATIVE_NET',
      severity: 'BLOCKER',
      message: `Net pay is negative (${money.fromMinor(netMinor)}); deductions exceed earnings`,
    });
  }

  return {
    earnings,
    grossMinor,
    reimbursements,
    employeeDeductions,
    employerContributions,
    totalEmployeeDeductionsMinor,
    totalEmployerContributionsMinor,
    reimbursementsMinor: reimbTotalMinor,
    netMinor,
    bases,
    anomalies,
    explain,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve the payable-days fraction `f = payableDays / standardDays` and a
 * memoized multiplier applier. NONE-policy components ignore it.
 */
function resolveProration(inputs, period, trace) {
  const lopDays = num(inputs.lopDays, 0);

  // standardDays precedence: explicit input > derived from period > 30.
  let calendarStandard = num(inputs.standardDays, 0);
  if (!calendarStandard) calendarStandard = num(inputs.calendarDays, 0);
  if (!calendarStandard && period.start && period.end) {
    calendarStandard = daysBetweenInclusive(period.start, period.end);
  }
  if (!calendarStandard) calendarStandard = 30;

  const workingStandard = num(inputs.workingDays, 0) || calendarStandard;

  // payableDays precedence: explicit > standard − lop.
  const explicitPayable = inputs.payableDays != null ? num(inputs.payableDays, 0) : null;

  trace({
    op: 'LOP',
    base: 'PRORATION',
    params: { lopDays, calendarStandard, workingStandard, explicitPayable },
    note: `LOP ${lopDays} day(s); standard ${calendarStandard} day(s)`,
  });

  return {
    lopDays,
    calendarStandard,
    workingStandard,
    explicitPayable,
    fixed30: 30,
    fixed26: 26,
  };
}

/**
 * Apply proration to a full (unprorated) amount per policy. Returns
 * { prorated, num, den } so the trace can record the exact fraction.
 */
function applyProration(fullMinor, def, proration, trace) {
  const policy = def.prorationPolicy || PRORATION.CALENDAR_DAYS;
  const lop = def.lopBehavior || LOP_BEHAVIOR.REDUCES_WITH_LOP;
  const roundMode = def.roundMode || RoundingMode.HALF_UP;

  if (policy === PRORATION.NONE || lop === LOP_BEHAVIOR.FIXED_REGARDLESS) {
    return { prorated: fullMinor, numDays: null, denDays: null };
  }

  let standard;
  switch (policy) {
    case PRORATION.FIXED_30:
      standard = proration.fixed30;
      break;
    case PRORATION.FIXED_26:
      standard = proration.fixed26;
      break;
    case PRORATION.WORKING_DAYS:
      standard = proration.workingStandard;
      break;
    case PRORATION.CALENDAR_DAYS:
    default:
      standard = proration.calendarStandard;
      break;
  }

  const payable =
    proration.explicitPayable != null
      ? proration.explicitPayable
      : standard - proration.lopDays;

  if (payable >= standard) {
    return { prorated: fullMinor, numDays: standard, denDays: standard };
  }
  if (payable <= 0) {
    return { prorated: 0, numDays: 0, denDays: standard };
  }

  // Exact integer rational: fullMinor * payableDays / standardDays.
  // Days may be fractional (e.g. half-day LOP); scale to integers first.
  const dayScale = 10000; // 4 dp on days, matches schema Decimal(8,4)
  const numD = Math.round(payable * dayScale);
  const denD = Math.round(standard * dayScale);
  const numerator = fullMinor * numD;
  let prorated;
  if (Number.isSafeInteger(numerator)) {
    prorated = money.roundRational(numerator, denD, roundMode);
  } else {
    prorated = money.percentOf(fullMinor, (numD / denD) * 100, roundMode);
  }
  trace({
    op: 'PRORATE',
    componentCode: def.code,
    inputs: [{ ref: def.code + ':full', amountMinor: fullMinor }],
    params: { payableDays: payable, standardDays: standard, policy, roundMode },
    outputMinor: prorated,
    note: `Prorated ${def.code}: ${money.fromMinor(fullMinor)} × ${payable}/${standard}`,
  });
  return { prorated, numDays: payable, denDays: standard };
}

/** Evaluate one EARNING component to its final (prorated, clamped) amount. */
function evalEarning(def, ctx, trace) {
  const { proration, inputs, earningByCode } = ctx;
  const roundMode = def.roundMode || RoundingMode.HALF_UP;
  let full;
  let baseMinor = null;

  switch (def.calcMethod) {
    case CALC.FIXED:
      money.assertMinor(def.amountMinor, `${def.code}.amountMinor`);
      full = def.amountMinor;
      break;
    case CALC.PERCENT_OF_BASE: {
      baseMinor = resolveBase(def, earningByCode, ctx);
      full = money.percentOf(baseMinor, num(def.percent, 0), roundMode);
      trace({
        op: 'PERCENT',
        componentCode: def.code,
        inputs: [{ ref: def.baseCode || def.ofBase || 'BASE', amountMinor: baseMinor }],
        params: { percent: def.percent, roundMode },
        outputMinor: full,
        note: `${def.code} = ${def.percent}% of ${money.fromMinor(baseMinor)}`,
      });
      break;
    }
    case CALC.ATTENDANCE_DRIVEN: {
      const hours = num(inputs[def.hoursField || 'otHours'], 0);
      money.assertMinor(def.ratePerHourMinor, `${def.code}.ratePerHourMinor`);
      // hours can be fractional -> exact rational rate*hours.
      const hScale = 100; // 2 dp on hours
      const numerator = def.ratePerHourMinor * Math.round(hours * hScale);
      full = money.roundRational(numerator, hScale, roundMode);
      trace({
        op: 'FORMULA',
        componentCode: def.code,
        params: { hours, ratePerHourMinor: def.ratePerHourMinor },
        outputMinor: full,
        note: `${def.code} = ${hours}h × ${money.fromMinor(def.ratePerHourMinor)}/h`,
      });
      // Attendance-driven earnings are already a function of worked time; do not
      // also prorate them.
      return finishComponent(def, full, baseMinor, /*skipProration*/ true, proration, trace);
    }
    default:
      throw new RangeError(`evalEarning: ${def.code} unsupported calcMethod ${def.calcMethod}`);
  }

  return finishComponent(def, full, baseMinor, false, proration, trace);
}

/** Apply proration then floor/cap then attach trace metadata. */
function finishComponent(def, full, baseMinor, skipProration, proration, trace) {
  let amountMinor = full;
  if (!skipProration) {
    amountMinor = applyProration(full, def, proration, trace).prorated;
  }
  if (def.floorMinor != null || def.capMinor != null) {
    const before = amountMinor;
    amountMinor = money.clampMinor(amountMinor, {
      floorMinor: def.floorMinor ?? null,
      capMinor: def.capMinor ?? null,
    });
    if (amountMinor !== before) {
      trace({
        op: amountMinor > before ? 'FLOOR' : 'CAP',
        componentCode: def.code,
        inputs: [{ ref: def.code, amountMinor: before }],
        params: { floorMinor: def.floorMinor ?? null, capMinor: def.capMinor ?? null },
        outputMinor: amountMinor,
        note: `${def.code} clamped ${money.fromMinor(before)} → ${money.fromMinor(amountMinor)}`,
      });
    }
  }
  return {
    code: def.code,
    label: def.name || def.code,
    amountMinor,
    baseMinor,
    showOnPayslip: def.showOnPayslip !== false,
    explain: def.explain || null,
    _order: def._order ?? Number.MAX_SAFE_INTEGER,
  };
}

/** Evaluate a simple (voluntary deduction / reimbursement / employer cost) component. */
function evalSimple(def, ctx, trace) {
  const roundMode = def.roundMode || RoundingMode.HALF_UP;
  switch (def.calcMethod) {
    case CALC.FIXED:
    case CALC.BALANCE_RECOVERY:
      money.assertMinor(def.amountMinor, `${def.code}.amountMinor`);
      return money.clampMinor(def.amountMinor, {
        floorMinor: def.floorMinor ?? null,
        capMinor: def.capMinor ?? null,
      });
    case CALC.PERCENT_OF_BASE: {
      const baseMinor =
        def.baseCode === 'GROSS' || def.ofBase === 'GROSS'
          ? ctx.grossMinor
          : resolveBase(def, ctx.earningByCode, ctx);
      const amt = money.percentOf(baseMinor, num(def.percent, 0), roundMode);
      trace({
        op: 'PERCENT',
        componentCode: def.code,
        inputs: [{ ref: def.baseCode || 'GROSS', amountMinor: baseMinor }],
        params: { percent: def.percent },
        outputMinor: amt,
        note: `${def.code} = ${def.percent}% of ${money.fromMinor(baseMinor)}`,
      });
      return money.clampMinor(amt, {
        floorMinor: def.floorMinor ?? null,
        capMinor: def.capMinor ?? null,
      });
    }
    default:
      throw new RangeError(`evalSimple: ${def.code} unsupported calcMethod ${def.calcMethod}`);
  }
}

/** Resolve the base for a PERCENT_OF_BASE component (a named component or GROSS). */
function resolveBase(def, earningByCode, ctx) {
  const key = def.baseCode || def.ofBase;
  if (!key || key === 'GROSS') {
    // Sum of all earnings computed so far.
    return money.sumMinor(Array.from(earningByCode.values()));
  }
  if (earningByCode.has(key)) return earningByCode.get(key);
  throw new RangeError(`resolveBase: ${def.code} references unknown base "${key}"`);
}

/** Σ amounts of earnings whose definition matches `predicate(def)`. */
function sumFlagged(earnings, earningByCode, defs, predicate) {
  const defByCode = new Map(defs.map((d) => [d.code, d]));
  let total = 0;
  for (const e of earnings) {
    const def = defByCode.get(e.code);
    if (def && predicate(def)) total += e.amountMinor;
  }
  return total;
}

/** Snapshot of computed earnings handed to the module (code + amount + flags). */
function componentSnapshotForModule(earnings, earningByCode, defs) {
  const defByCode = new Map(defs.map((d) => [d.code, d]));
  return earnings.map((e) => {
    const def = defByCode.get(e.code) || {};
    return {
      code: e.code,
      amountMinor: e.amountMinor,
      isBasic: !!def.isBasic,
      isPfWages: !!def.isPfWages,
      isEsiWages: !!def.isEsiWages,
      isPtWages: !!def.isPtWages,
      isGratuityWages: !!def.isGratuityWages,
      isNzGrossEarnings: !!def.isNzGrossEarnings,
      isKiwiSaverable: !!def.isKiwiSaverable,
      isPayeable: def.isPayeable !== false,
      isTaxable: def.isTaxable !== false,
    };
  });
}

function num(v, dflt) {
  if (v == null) return dflt;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Inclusive whole-day count between two YYYY-MM-DD strings or Date objects. */
function daysBetweenInclusive(start, end) {
  const s = toUTCDate(start);
  const e = toUTCDate(end);
  const ms = e - s;
  return Math.round(ms / 86400000) + 1;
}

function toUTCDate(d) {
  if (d instanceof Date) return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  if (!m) throw new TypeError(`Invalid date: ${d}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

module.exports = {
  computePayslip,
  CATEGORY,
  PRORATION,
  LOP_BEHAVIOR,
  CALC,
  // exported for tests
  _internal: { applyProration, resolveProration, sumFlagged, daysBetweenInclusive },
};
