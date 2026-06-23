'use strict';

/**
 * deriveBreakup.js — PURE target-CTC → component-amount reverse-derivation.
 *
 * The inverse of the payroll engine: where engine.js takes a resolved structure
 * and computes the payslip, this takes a TARGET (CTC | gross) plus an ordered set
 * of structure lines and DERIVES the per-component monthly amounts — including the
 * BALANCING (special-allowance) residual that fills to the target gross. It is the
 * quote-time authority; the runtime authority stays engine.computePayslip. The two
 * are golden-tested to agree to the paise (the §4.1 replay-parity contract).
 *
 * PURE: no DB, no I/O, no Date.now. All arithmetic in INTEGER MINOR UNITS via
 * payroll/money.js. Unit-testable with plain `node`.
 *
 * Mirrors the engine's three earning passes (engine.js:164-188):
 *   pass 0  FLAT earnings           (derivationPass 0)
 *   pass 1  PERCENT_OF literal base (derivationPass 1)   base = a named component
 *   pass 2  PERCENT_OF GROSS/CTC    (derivationPass 2)   base = targetGross | CTC
 *   pass 3  BALANCING residual      (derivationPass 3)   special = targetGross − Σ(others)
 *
 * Lines are ordered by (derivationPass, sortOrder). A line's pass is taken from
 * its component's `derivationPass` field when present; otherwise it is INFERRED
 * from calcMethod + base (so existing structures without the new column still
 * derive correctly).
 */

const money = require('./../payroll/money');
const india = require('./../payroll/compliance/india');

const { RoundingMode } = money;

// ── calcMethod constants (DB ComponentCalcMethod) ──
const CALC = Object.freeze({
  FLAT: 'FLAT',
  PERCENT_OF: 'PERCENT_OF',
  FORMULA: 'FORMULA',
  SLAB: 'SLAB',
  STATUTORY: 'STATUTORY',
  BALANCING: 'BALANCING',
});

const STD_PROVISION_PCT_NUM = 481; // gratuity provision ≈ 4.81% of Basic+DA
const STD_PROVISION_PCT_DEN = 100; // = 15/26/12 ≈ 0.0481 (standard CTC provision)

class DeriveError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'DeriveError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Resolve the topo pass for a line. Explicit `derivationPass` on the component
 * wins (lets the structure builder reject cycles at save time); otherwise infer.
 */
function passFor(line) {
  const comp = line.component || {};
  const method = (line.calcMethod || comp.calcMethod || CALC.FLAT);
  // FIX (#30): an EXPLICIT per-line BALANCING method always resolves in pass 3
  // (the residual fill), even when the component carries a stored derivationPass
  // for a different role. Without this, a BALANCING line on a component whose
  // stored derivationPass is 0/1/2 ran in the wrong pass and the residual never
  // filled — the balancing component resolved to 0. The per-line rule wins.
  if (method === CALC.BALANCING) return 3;
  if (Number.isInteger(comp.derivationPass)) return comp.derivationPass;
  if (method === CALC.PERCENT_OF) {
    const base = comp.calcBaseScope;
    if (base === 'GROSS' || base === 'CTC') return 2;
    return 1; // PERCENT_OF a literal/named component
  }
  return 0; // FLAT / FORMULA / others treated as literal pass 0
}

/** Coerce a Decimal | number | numeric-string | null to integer minor units. */
function toMinorSafe(value, scale = 2) {
  if (value == null || value === '') return 0;
  let s;
  if (typeof value === 'object' && typeof value.toFixed === 'function') s = value.toFixed(scale);
  else if (typeof value === 'number') s = value.toFixed(scale);
  else s = String(value);
  return money.toMinor(s, scale);
}

/** A percent value (12, 8.33, "50") as a JS number for money.percentOf. */
function toPercent(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampLine(amountMinor, comp) {
  const floorMinor = comp.floorValue != null ? toMinorSafe(comp.floorValue) : null;
  const capMinor = comp.capValue != null ? toMinorSafe(comp.capValue) : null;
  if (floorMinor == null && capMinor == null) return amountMinor;
  return money.clampMinor(amountMinor, { floorMinor, capMinor });
}

/**
 * employerCostFixedPoint — quote-time employer cost for an IN CTC-basis package.
 *
 * employer PF/ESI/gratuity are a function of PF-wages (≈ Basic+DA) which is a
 * function of CTC; gross = CTC − employerCost. Bounded fixed-point (≤ `maxIters`,
 * the ₹15,000 PF ceiling bounds growth). The ENGINE owns the runtime statutory
 * amounts; this loop only QUOTES so the breakup reconciles. Validated by the
 * §4.1 replay parity (quoted cost == engine runtime cost).
 *
 * @param {Object} p
 * @param {number} p.ctcAnnualMinor   target annual CTC, minor units
 * @param {(grossMonthlyMinor:number)=>number} p.resolveBasicDaMonthly
 *        given a candidate MONTHLY gross, return the MONTHLY Basic+DA the
 *        structure would yield (so PF wages track the structure, not a guess).
 * @param {boolean} [p.capPfAtCeiling=true]
 * @param {boolean} [p.esiApplicable=false]
 * @param {string}  [p.asOf]
 * @returns {{ employerCostAnnualMinor, employerCostMonthlyMinor, basicDaMonthlyMinor, items }}
 */
function employerCostFixedPoint({
  ctcAnnualMinor,
  resolveBasicDaMonthly,
  capPfAtCeiling = true,
  esiApplicable = false,
  // Raised from 4 → 8: now that convergence is ASSERTED (we throw rather than
  // silently ship the last value), the loop needs comfortable headroom. A linear
  // Basic+DA=½·gross structure converges in ~6 iters near the ₹15k PF ceiling
  // boundary; 8 gives margin while still bounding a genuinely diverging quote.
  maxIters = 8,
}) {
  money.assertMinor(ctcAnnualMinor, 'ctcAnnualMinor');
  const ctcMonthlyMinor = money.roundRational(ctcAnnualMinor, 12, RoundingMode.HALF_UP);

  let employerCostMonthly = 0;
  let basicDaMonthly = 0;
  let items = [];
  let converged = false;
  let lastDelta = null;

  for (let i = 0; i < maxIters; i += 1) {
    const grossMonthly = money.subMinor(ctcMonthlyMinor, employerCostMonthly);
    basicDaMonthly = Math.max(0, resolveBasicDaMonthly(grossMonthly));

    // Employer PF split (EPS + EPF A/c1 + EDLI + admin) on the Basic+DA wage.
    const epf = india._internals.computeEpf({
      pfWageMinor: basicDaMonthly,
      capAtCeiling: capPfAtCeiling,
      establishmentHasContributoryMember: true,
    });
    const employerPf = epf.epfErMinor + epf.epsMinor + epf.edliMinor + epf.pfAdminMinor;

    let employerEsi = 0;
    if (esiApplicable) {
      const esi = india._internals.computeEsi({ esiGrossMinor: grossMonthly });
      employerEsi = esi.esiErMinor || 0;
    }

    // Gratuity provision ≈ 4.81% of Basic+DA (15/26/12) — standard CTC accrual.
    const gratuityProvision = money.percentOf(
      basicDaMonthly,
      STD_PROVISION_PCT_NUM / STD_PROVISION_PCT_DEN,
      RoundingMode.HALF_UP,
    );

    const next = employerPf + employerEsi + gratuityProvision;
    items = [
      { code: 'PF_EMPLOYER', amountMinor: epf.epfErMinor },
      { code: 'EPS', amountMinor: epf.epsMinor },
      { code: 'EDLI', amountMinor: epf.edliMinor },
      { code: 'PF_ADMIN', amountMinor: epf.pfAdminMinor },
      ...(esiApplicable ? [{ code: 'ESI_EMPLOYER', amountMinor: employerEsi }] : []),
      { code: 'GRATUITY_PROVISION', amountMinor: gratuityProvision },
    ];

    lastDelta = Math.abs(next - employerCostMonthly);
    if (lastDelta <= 1) {
      employerCostMonthly = next;
      converged = true;
      break;
    }
    employerCostMonthly = next;
  }

  // Fail-closed: a quote that did NOT converge to within 1 paise after maxIters
  // would silently ship an off-by-N-paise CTC/gross split (targetGross =
  // ctcMonthly − employerCostMonthly is then wrong). Never persist that.
  if (!converged) {
    throw new DeriveError(
      'EMPLOYER_COST_DIVERGED',
      `employer-cost fixed point did not converge within ${maxIters} iterations (residual ${lastDelta} paise)`,
      { residualMinor: lastDelta, maxIters },
    );
  }

  return {
    employerCostMonthlyMinor: employerCostMonthly,
    employerCostAnnualMinor: employerCostMonthly * 12,
    basicDaMonthlyMinor: basicDaMonthly,
    items,
  };
}

/**
 * deriveBreakup({ target, basis, lines, ctx }) → { resolved, gross, net?,
 *   employerCost, targetGrossMinor, wagesVerdict }
 *
 * @param {Object} args
 * @param {Object} args.target  one of:
 *        { ctcAnnualMinor }  (basis CTC) | { grossMonthlyMinor } (basis GROSS)
 *        amounts in INTEGER MINOR UNITS.
 * @param {('CTC'|'GROSS'|'NET')} args.basis
 * @param {Array}  args.lines   SalaryComponentLine rows joined to .component.
 *        Each: { component:{ code, kind, category, calcMethod, calcBaseCode,
 *                 calcBaseScope, derivationPass?, floorValue?, capValue?,
 *                 isWageForPF?, ... }, calcMethod?, calcValue?, sortOrder? }
 * @param {Object} [args.ctx]   { countryCode, asOf, capPfAtCeiling?, esiApplicable? }
 * @returns {Object}
 *   resolved:  [{ code, componentId, category, calcMethod, amountMonthlyMinor,
 *                 amountAnnualMinor, baseMinor?, isBalancing }]
 *   grossMinor, targetGrossMinor, employerCost{ monthlyMinor, annualMinor, items },
 *   wagesVerdict: { ok, wagesMinor?, floorMinor?, ruleApplied, applies }
 */
function deriveBreakup({ target = {}, basis, lines, ctx = {} }) {
  if (!Array.isArray(lines)) throw new TypeError('deriveBreakup: lines must be an array');
  if (basis === 'NET') {
    throw new DeriveError('UNSUPPORTED_NET_BASIS', 'basis=NET (net→gross gross-up) is not supported in v1');
  }
  const countryCode = (ctx.countryCode || '').toUpperCase();
  const isIndia = countryCode === 'IN';

  // Order lines by (pass, sortOrder, declared index) — pure, stable.
  const ordered = lines
    .map((line, idx) => ({ line, idx, pass: passFor(line) }))
    .sort((a, b) => (a.pass - b.pass) || ((a.line.sortOrder || 0) - (b.line.sortOrder || 0)) || (a.idx - b.idx));

  // Validate ≤1 BALANCING line up front (matches the structure-builder rule).
  const balancingCount = ordered.filter((o) => o.pass === 3
    || (o.line.calcMethod || (o.line.component || {}).calcMethod) === CALC.BALANCING).length;
  if (balancingCount > 1) {
    throw new DeriveError('MULTIPLE_BALANCING', 'a structure may declare at most one BALANCING component');
  }

  // ── 1. Split target → targetGrossMinor + employer cost (IN CTC fixed point) ──
  let targetGrossMinor;
  let employerCost = { monthlyMinor: 0, annualMinor: 0, items: [], basicDaMonthlyMinor: 0 };

  // Pre-compute the EARNING lines' shape so the fixed point can quote Basic+DA
  // for a candidate gross. This re-runs the earning passes (pure, cheap).
  const earningDefs = ordered.filter((o) => ((o.line.component || {}).category || 'EARNING') === 'EARNING');

  if (basis === 'CTC') {
    const ctcAnnualMinor = target.ctcAnnualMinor;
    money.assertMinor(ctcAnnualMinor, 'target.ctcAnnualMinor');
    if (isIndia) {
      const fp = employerCostFixedPoint({
        ctcAnnualMinor,
        capPfAtCeiling: ctx.capPfAtCeiling !== false,
        esiApplicable: ctx.esiApplicable === true,
        asOf: ctx.asOf,
        resolveBasicDaMonthly: (grossMonthly) => {
          const r = resolveEarnings(earningDefs, grossMonthly, ctcAnnualMinor);
          return r.basicDaMinor;
        },
      });
      employerCost = {
        monthlyMinor: fp.employerCostMonthlyMinor,
        annualMinor: fp.employerCostAnnualMinor,
        items: fp.items,
        basicDaMonthlyMinor: fp.basicDaMonthlyMinor,
      };
      const ctcMonthly = money.roundRational(ctcAnnualMinor, 12, RoundingMode.HALF_UP);
      targetGrossMinor = money.subMinor(ctcMonthly, fp.employerCostMonthlyMinor);
    } else {
      // Non-IN CTC: gross == CTC/12 (employer cost reported on top, not folded).
      targetGrossMinor = money.roundRational(ctcAnnualMinor, 12, RoundingMode.HALF_UP);
    }
  } else if (basis === 'GROSS') {
    targetGrossMinor = target.grossMonthlyMinor;
    money.assertMinor(targetGrossMinor, 'target.grossMonthlyMinor');
  } else {
    throw new DeriveError('UNKNOWN_BASIS', `unknown basis "${basis}"`);
  }

  if (targetGrossMinor < 0) {
    throw new DeriveError('STRUCTURE_INFEASIBLE', 'employer cost exceeds CTC; target gross is negative');
  }

  // ── 2–6. Resolve the earnings (literal/percent/balancing) to the target ──
  const earnResult = resolveEarnings(earningDefs, targetGrossMinor, basis === 'CTC' ? target.ctcAnnualMinor : null);
  if (earnResult.infeasible) {
    throw new DeriveError(
      'STRUCTURE_INFEASIBLE',
      `fixed + percent earnings (${money.fromMinor(earnResult.nonBalancingSum)}) exceed the target gross (${money.fromMinor(targetGrossMinor)}) and there is no balancing line to absorb the gap`,
      { nonBalancingSumMinor: earnResult.nonBalancingSum, targetGrossMinor },
    );
  }

  // Non-earning lines (DEDUCTION/EMPLOYER_COST/REIMBURSEMENT) pass through as
  // declared flat amounts — the engine/compliance module owns statutory ones at
  // runtime; here we only echo what the structure declares.
  const resolved = earnResult.resolved.slice();
  for (const o of ordered) {
    const comp = o.line.component || {};
    const category = comp.category || 'EARNING';
    if (category === 'EARNING') continue;
    const amt = clampLine(toMinorSafe(o.line.amountMonthly != null ? o.line.amountMonthly : o.line.calcValue), comp);
    resolved.push({
      code: comp.code,
      componentId: comp.id || o.line.componentId || null,
      category,
      calcMethod: o.line.calcMethod || comp.calcMethod || CALC.FLAT,
      amountMonthlyMinor: amt,
      amountAnnualMinor: amt * 12,
      isBalancing: false,
    });
  }

  // ── 7. Gross == Σ earnings (reconciles to target to the paise) ──
  const grossMinor = money.sumMinor(earnResult.resolved.map((r) => r.amountMonthlyMinor));

  // ── 8. Wage verdict (IN 50% Basic+DA floor, country-gated) ──
  const wagesVerdict = computeWagesVerdict({
    isIndia,
    grossMinor,
    basicDaMinor: earnResult.basicDaMinor,
    asOf: ctx.asOf,
  });

  return {
    resolved,
    grossMinor,
    targetGrossMinor,
    employerCost: {
      monthlyMinor: employerCost.monthlyMinor,
      annualMinor: employerCost.annualMinor,
      items: employerCost.items,
    },
    basicDaMonthlyMinor: earnResult.basicDaMinor,
    wagesVerdict,
  };
}

/**
 * resolveEarnings — the engine's three earning passes, run forward against a
 * KNOWN targetGross. PURE. Returns resolved earning lines + Basic+DA sum.
 *
 * @param earningDefs  ordered [{line, pass, idx}] EARNING lines
 * @param targetGrossMinor   the gross the package reconciles to
 * @param ctcAnnualMinor     for PERCENT_OF a CTC base (null when basis≠CTC)
 */
function resolveEarnings(earningDefs, targetGrossMinor, ctcAnnualMinor) {
  const byCode = new Map(); // code → amountMonthlyMinor
  const resolved = [];
  let basicDaMinor = 0;
  let hasBalancing = false;

  const ctcMonthlyMinor = ctcAnnualMinor != null
    ? money.roundRational(ctcAnnualMinor, 12, RoundingMode.HALF_UP)
    : targetGrossMinor;

  const push = (o, amountMinor, baseMinor, isBalancing) => {
    const comp = o.line.component || {};
    // The BALANCING residual MUST land at the exact paise gap (targetGross −
    // Σothers); clamping it would silently break Σresolved === targetGross. If a
    // floor/cap is configured on the balancing line AND it would bite, that is a
    // structurally-infeasible structure (the cap/floor cannot reconcile to the
    // target) → throw rather than ship a drifting breakup.
    let amount = amountMinor;
    if (isBalancing) {
      const clamped = clampLine(amountMinor, comp);
      if (clamped !== amountMinor) {
        throw new DeriveError(
          'STRUCTURE_INFEASIBLE',
          `the BALANCING component ${comp.code || ''} has a floor/cap that prevents it from absorbing the residual (residual ${money.fromMinor(amountMinor)} would clamp to ${money.fromMinor(clamped)}); Σ components cannot reconcile to the target gross`,
          { residualMinor: amountMinor, clampedMinor: clamped },
        );
      }
      amount = amountMinor; // residual passes through UNCLAMPED
    } else {
      amount = clampLine(amountMinor, comp);
    }
    byCode.set(comp.code, amount);
    if (comp.kind === 'BASIC' || comp.kind === 'DEARNESS_ALLOWANCE') basicDaMinor += amount;
    resolved.push({
      code: comp.code,
      componentId: comp.id || o.line.componentId || null,
      category: 'EARNING',
      calcMethod: o.line.calcMethod || comp.calcMethod || CALC.FLAT,
      amountMonthlyMinor: amount,
      amountAnnualMinor: amount * 12,
      baseMinor: baseMinor != null ? baseMinor : undefined,
      isBalancing: !!isBalancing,
      _order: o.idx,
    });
  };

  // Pass 0 — FLAT (literal) earnings.
  for (const o of earningDefs) {
    if (o.pass !== 0) continue;
    const amt = toMinorSafe(o.line.amountMonthly != null ? o.line.amountMonthly : o.line.calcValue);
    push(o, amt, null, false);
  }
  // Pass 2 — PERCENT_OF GROSS/CTC (the base is a KNOWN constant). Run this
  // BEFORE pass 1: a literal-base percent (e.g. HRA=%of BASIC) commonly depends
  // on a CTC/GROSS-based component (e.g. BASIC=%of CTC), so the constant-base
  // pass must resolve first.
  for (const o of earningDefs) {
    if (o.pass !== 2) continue;
    const comp = o.line.component || {};
    const baseMinor = comp.calcBaseScope === 'CTC' ? ctcMonthlyMinor : targetGrossMinor;
    const amt = money.percentOf(baseMinor, toPercent(o.line.calcValue), RoundingMode.HALF_UP);
    push(o, amt, baseMinor, false);
  }
  // Pass 1 — PERCENT_OF a named (literal/component) base — may reference a
  // pass-0 or pass-2 earning resolved above.
  for (const o of earningDefs) {
    if (o.pass !== 1) continue;
    const comp = o.line.component || {};
    const baseKey = comp.calcBaseCode;
    let baseMinor;
    if (!baseKey || baseKey === 'GROSS') baseMinor = targetGrossMinor;
    else if (baseKey === 'CTC') baseMinor = ctcMonthlyMinor;
    else if (byCode.has(baseKey)) baseMinor = byCode.get(baseKey);
    else throw new DeriveError('UNKNOWN_BASE', `${comp.code} references unknown base "${baseKey}"`);
    const amt = money.percentOf(baseMinor, toPercent(o.line.calcValue), RoundingMode.HALF_UP);
    push(o, amt, baseMinor, false);
  }

  const nonBalancingSum = money.sumMinor(resolved.map((r) => r.amountMonthlyMinor));

  // Pass 3 — BALANCING residual: fills to targetGross, floored at 0, absorbs drift.
  for (const o of earningDefs) {
    if (o.pass !== 3) continue;
    hasBalancing = true;
    let special = money.subMinor(targetGrossMinor, nonBalancingSum);
    if (special < 0) special = 0; // never a negative earning
    push(o, special, targetGrossMinor, true);
  }

  // Reconciliation. With a balancing line Σ == target exactly (residual absorbed).
  // Without one, over-allocation is INFEASIBLE; under-allocation is a (legal)
  // shortfall (the structure simply does not reach the target gross).
  if (!hasBalancing && nonBalancingSum > targetGrossMinor) {
    return { infeasible: true, nonBalancingSum, resolved: [], basicDaMinor: 0 };
  }

  // PARITY ASSERT (§4.1): with a balancing line the components MUST sum to the
  // target gross to the paise. If the residual was floored at 0 (nonBalancingSum
  // already > target with a balancing line present) Σ would exceed the target —
  // that is infeasible, not a silent over-allocation.
  if (hasBalancing) {
    const resolvedSum = money.sumMinor(resolved.map((r) => r.amountMonthlyMinor));
    if (resolvedSum !== targetGrossMinor) {
      throw new DeriveError(
        'STRUCTURE_INFEASIBLE',
        `Σ resolved earnings (${money.fromMinor(resolvedSum)}) != target gross (${money.fromMinor(targetGrossMinor)}); the BALANCING residual could not reconcile`,
        { resolvedSumMinor: resolvedSum, targetGrossMinor },
      );
    }
  }

  resolved.sort((a, b) => (a._order - b._order));
  for (const r of resolved) delete r._order;
  return { infeasible: false, resolved, basicDaMinor, nonBalancingSum, hasBalancing };
}

function computeWagesVerdict({ isIndia, grossMinor, basicDaMinor, asOf }) {
  if (!isIndia) return { applies: false, ok: true, ruleApplied: false };
  if (!grossMinor || grossMinor <= 0) {
    // Fail-CLOSED: an INR package with no resolvable gross cannot be judged safe.
    return { applies: true, ok: false, code: 'WAGES_50_RULE', reason: 'no resolvable gross', ruleApplied: false };
  }
  const wages = india._internals.computeStatutoryWages({
    periodGrossMinor: grossMinor,
    basicDaMinor,
    asOf: asOf || new Date().toISOString().slice(0, 10),
  });
  if (wages.breach) {
    return {
      applies: true,
      ok: false,
      code: 'WAGES_50_RULE',
      wagesMinor: basicDaMinor,
      floorMinor: wages.floorMinor,
      grossMinor,
      ruleApplied: true,
    };
  }
  return {
    applies: true,
    ok: true,
    wagesMinor: basicDaMinor,
    floorMinor: wages.floorMinor != null ? wages.floorMinor : null,
    grossMinor,
    ruleApplied: wages.ruleApplied,
  };
}

/**
 * materializeRevisionLines(structure, ctxAmounts) → SalaryComponentLineCreate[]
 *
 * Runs deriveBreakup and emits Prisma `create` rows ready to nest under a
 * CompensationRevision (or a SalaryStructure). Each line carries the resolved
 * snapshot (amountMonthly/amountAnnual) so payroll reads a CONCRETE package, and
 * the calcMethod/calcValue so the engine recomputes identically. Rounds ONCE per
 * component; the BALANCING line absorbs the residual so Σ reconciles exactly.
 *
 * THIS is wired into provision.js STEP 8 (the zero-gross bug fix) and every
 * revision/cycle-commit path.
 *
 * @param {Object} structure  { lines:[ {component, calcMethod?, calcValue?, sortOrder?} ], basis }
 * @param {Object} ctxAmounts {
 *        target: { ctcAnnualMinor } | { grossMonthlyMinor },
 *        basis,                     // overrides structure.basis if given
 *        countryCode, asOf, businessId, capPfAtCeiling?, esiApplicable?
 *      }
 * @returns {{ lines: Array, breakup: Object }} Prisma line-create rows + the breakup.
 */
function materializeRevisionLines(structure, ctxAmounts = {}) {
  const lines = Array.isArray(structure && structure.lines) ? structure.lines : [];
  const basis = ctxAmounts.basis || (structure && structure.basis);
  const breakup = deriveBreakup({
    target: ctxAmounts.target || {},
    basis,
    lines,
    ctx: {
      countryCode: ctxAmounts.countryCode,
      asOf: ctxAmounts.asOf,
      capPfAtCeiling: ctxAmounts.capPfAtCeiling,
      esiApplicable: ctxAmounts.esiApplicable,
    },
  });

  // Map resolved earnings/lines back to their source line so we keep the
  // declared calcMethod/calcValue/sortOrder/componentId verbatim.
  const lineByCode = new Map();
  for (const l of lines) {
    const code = (l.component && l.component.code) || l.code;
    if (code != null) lineByCode.set(code, l);
  }

  const out = breakup.resolved.map((r, i) => {
    const src = lineByCode.get(r.code) || {};
    const comp = src.component || {};
    const componentId = r.componentId || src.componentId || comp.id || null;
    const calcMethod = src.calcMethod || comp.calcMethod || r.calcMethod || CALC.FLAT;
    return {
      componentId,
      calcMethod,
      // Preserve the declared rule input (percent / flat) for engine recompute.
      calcValue: src.calcValue != null ? src.calcValue : null,
      amountMonthly: money.fromMinor(r.amountMonthlyMinor),
      amountAnnual: money.fromMinor(r.amountAnnualMinor),
      sortOrder: src.sortOrder != null ? src.sortOrder : i,
    };
  });

  return { lines: out, breakup };
}

module.exports = {
  deriveBreakup,
  materializeRevisionLines,
  employerCostFixedPoint,
  DeriveError,
  // exported for tests
  _internal: { resolveEarnings, passFor, computeWagesVerdict, toMinorSafe },
};
