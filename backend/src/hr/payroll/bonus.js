'use strict';

/**
 * bonus.js — Statutory Bonus math core (Feature 22; Payment of Bonus Act 1965).
 *
 * PURE: no DB, no I/O, no prisma, no `new Date()` for the business math (the
 * caller supplies every amount + date + day-count in `ctx`). Unit-testable to the
 * exact paise with plain `node`, mirroring the payroll engine / compliance module
 * discipline (engine.js, compliance/india.js) and the fnf.js shape. The
 * orchestrator (bonusRun.controller.js) reads the DB (Employee, comp revision,
 * attendance/leave, separation cases), maps rows into the plain `ctx` below, calls
 * `computeBonusCycle`, persists BonusCycle/BonusAward, then mints a
 * PayRun(type=BONUS) from `payRunInput` via the SAME persist path the FnF
 * controller uses (offboarding.controller.js).
 *
 * MONEY: everything is INTEGER MINOR UNITS (paise). ₹1 = 100 paise.
 * Reuses the India compliance core — NEVER re-implements rounding/percentage:
 *   - resolveBonusRule(asOf=FYend) → effective-dated ceilings + rate band (₹21,000
 *     /₹7,000 from FY2014-15; ₹10,000/₹3,500 pre-2015).
 *   - pctExact(amountMinor, num, den) → exact integer-math percentage.
 *   - roundToRupeeNearest(minor)    → nearest ₹1 (EPF convention) for the payout.
 *
 * The result mirrors fnf.js 1:1: `computeBonusCycle(cycle, employees[])` returns
 * `{ ..., awards[], totals, payRunInput, setOnSetOff }` and `payRunInput` is the
 * exact mint-ready shape the FnF controller persists, with `type: 'BONUS'`.
 *
 * Statutory rule (Payment of Bonus Act 1965 + 2015 amendment):
 *   §2(13)  eligibility ceiling — monthly Basic+DA ≤ ₹21,000 (₹10,000 pre-2015)
 *   §8      ≥ 30 worked days in the accounting year
 *   §9      disqualification (fraud/theft/violence dismissal) → forfeits the year
 *   §10     minimum bonus 8.33% of the (capped) annual eligible wages
 *   §11     maximum bonus 20% (when allocable surplus permits)
 *   §12     calc base = min(monthly Basic+DA, max(₹7,000, min wage)) (₹3,500 pre-2015)
 *   §13     proportionate to worked/deemed days (paid leave/maternity/lay-off/injury
 *           are DEEMED worked; LWP/AWOL reduce eligible months)
 *   §15-16  set-on / set-off carry-forward (advisory ledger only)
 *   §19     pay within 8 months of the FY close
 */

const { _internals: indiaInternals } = require('./compliance/india');

const { roundToRupeeNearest, pctExact, resolveBonusRule } = indiaInternals;

// ── pure helpers (integer minor units only; never floats for money) ──────────
function int(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
function nonNeg(x) {
  return x < 0 ? 0 : x;
}
/** Clamp a basis-points rate into the statutory [min, max] band (8.33%..20%). */
function clampRate(bp, minBp, maxBp) {
  if (bp == null || !Number.isFinite(Number(bp))) return minBp;
  return Math.max(minBp, Math.min(maxBp, Math.round(Number(bp))));
}

const INELIGIBLE = Object.freeze({
  OVER_CEILING: 'OVER_CEILING',
  UNDER_30_DAYS: 'UNDER_30_DAYS',
  DISQUALIFIED_S9: 'DISQUALIFIED_S9',
  NOT_COVERED: 'NOT_COVERED',
});

/**
 * resolveCycleParams — derive the effective-dated, paise-normalised parameters
 * for an accounting year from the rule version + cycle inputs. PURE.
 *
 * @param accountingYearEnd  'YYYY-MM-DD' end of the FY (e.g. '2026-03-31')
 * @param rateBasisPoints    declared rate in bp (833..2000); clamped into band
 * @param minWageMonthlyMinor optional per-scheduled-employment min wage (paise);
 *                            raises the ₹7,000 calc ceiling when higher
 * @returns { eligibilityCeilingMinor, calcCeilingMinor, rateBasisPoints, rateDen,
 *            minWorkedDays, effectiveFrom }
 */
function resolveCycleParams({ accountingYearEnd, rateBasisPoints, minWageMonthlyMinor = null }) {
  const rule = resolveBonusRule(accountingYearEnd);
  if (!rule) throw new Error(`bonus: no effective rule for FY ending ${accountingYearEnd}`);
  // §12 calc ceiling = max(₹7,000-from-rule, applicable minimum wage).
  const calcCeilingMinor = Math.max(
    rule.calcCeilingMinor,
    int(minWageMonthlyMinor) > 0 ? int(minWageMonthlyMinor) : 0,
  );
  return {
    eligibilityCeilingMinor: rule.eligibilityCeilingMinor,
    calcCeilingMinor,
    rateBasisPoints: clampRate(rateBasisPoints, rule.minRateNum, rule.maxRateNum),
    rateDen: rule.rateDen,
    minRateNum: rule.minRateNum,
    maxRateNum: rule.maxRateNum,
    minWorkedDays: rule.minWorkedDays,
    effectiveFrom: rule.effectiveFrom,
  };
}

/**
 * determineBonusEligibility — §2(13)/§8/§9 gate. PURE.
 *
 * @returns { eligible, ineligibleReason|null }
 */
function determineBonusEligibility({
  monthlyBasicDaMinor,
  workedDays,
  disqualifiedS9 = false,
  entityCovered = true,
  params, // from resolveCycleParams
}) {
  if (!entityCovered) return { eligible: false, ineligibleReason: INELIGIBLE.NOT_COVERED };
  // §2(13): monthly Basic+DA must be ≤ the ceiling (inclusive). ₹21,000 ok; ₹21,001 not.
  if (int(monthlyBasicDaMinor) > params.eligibilityCeilingMinor) {
    return { eligible: false, ineligibleReason: INELIGIBLE.OVER_CEILING };
  }
  // §9: dismissal for fraud/theft/violence forfeits the whole year.
  if (disqualifiedS9 === true) {
    return { eligible: false, ineligibleReason: INELIGIBLE.DISQUALIFIED_S9 };
  }
  // §8: ≥ 30 worked days in the accounting year.
  if (int(workedDays) < params.minWorkedDays) {
    return { eligible: false, ineligibleReason: INELIGIBLE.UNDER_30_DAYS };
  }
  return { eligible: true, ineligibleReason: null };
}

/**
 * computeBonusAward — the §10–§13 capped-base computation for ONE employee. PURE,
 * paise-exact. Assumes eligibility already determined (the caller passes the
 * verdict; an ineligible employee yields a zero award with the reason).
 *
 * cappedBaseMinor = min(monthlyBasicDaMinor, calcCeilingMinor)   (§12)
 * annualWageMinor = cappedBaseMinor × eligibleMonths             (§13 proration)
 * grossBonusMinor = roundToRupeeNearest(annualWageMinor × rate)  (§10/§11)
 * netBonusMinor   = max(0, grossBonusMinor − advancePaidMinor)   (§11 advance)
 *
 * @param eligibleMonths fractional months worked/deemed (Section 13). 12 = full year.
 * @returns the frozen per-employee award snapshot.
 */
function computeBonusAward({
  monthlyBasicDaMinor,
  eligibleMonths,
  advancePaidMinor = 0,
  params,
  eligible,
  ineligibleReason = null,
}) {
  const baseMinor = int(monthlyBasicDaMinor);
  const cappedBaseMinor = Math.min(baseMinor, params.calcCeilingMinor);
  const months = Number(eligibleMonths);
  const trace = [];

  if (!eligible) {
    return {
      eligible: false,
      ineligibleReason,
      monthlyBasicDaMinor: baseMinor,
      cappedBaseMinor,
      eligibleMonths: 0,
      rateBasisPoints: params.rateBasisPoints,
      grossBonusMinor: 0,
      advancePaidMinor: int(advancePaidMinor),
      netBonusMinor: 0,
      trace: [`ineligible: ${ineligibleReason}`],
    };
  }

  // §13 annual eligible wage = capped monthly base × eligible (fractional) months.
  // Months are exact to 2dp at the cycle edge; multiply in paise then round at the
  // statutory point (nearest ₹1) — never carry a float into the persisted payout.
  const annualWageMinor = Math.round(cappedBaseMinor * months);
  trace.push(
    `capped base ₹${(cappedBaseMinor / 100).toFixed(2)} = min(₹${(baseMinor / 100).toFixed(2)}, ₹${(params.calcCeilingMinor / 100).toFixed(2)})`,
  );
  trace.push(`annual eligible wage ₹${(annualWageMinor / 100).toFixed(2)} = base × ${months} months`);

  // §10/§11 bonus = rate × annual wage, rounded to the nearest ₹1 (EPF convention).
  const grossRaw = pctExact(annualWageMinor, params.rateBasisPoints, params.rateDen);
  const grossBonusMinor = roundToRupeeNearest(grossRaw);
  trace.push(
    `gross bonus ₹${(grossBonusMinor / 100).toFixed(2)} = ${(params.rateBasisPoints / 100).toFixed(2)}% of ₹${(annualWageMinor / 100).toFixed(2)} (→ nearest ₹1)`,
  );

  const advance = int(advancePaidMinor);
  const netBonusMinor = nonNeg(grossBonusMinor - advance);
  if (advance > 0) trace.push(`net ₹${(netBonusMinor / 100).toFixed(2)} = gross − advance ₹${(advance / 100).toFixed(2)} (floored at 0)`);

  return {
    eligible: true,
    ineligibleReason: null,
    monthlyBasicDaMinor: baseMinor,
    cappedBaseMinor,
    eligibleMonths: months,
    rateBasisPoints: params.rateBasisPoints,
    grossBonusMinor,
    advancePaidMinor: advance,
    netBonusMinor,
    trace,
  };
}

/**
 * computeSetOnSetOff — §15/§16 advisory ledger (Form B). PURE. NEVER gates an
 * individual award; surfaced only in the Form B/D advisory panel.
 *
 * Surplus above the 20% max bonus is SET-ON (carried forward up to 4 years); a
 * shortfall below the 8.33% min draws from prior SET-ON (set-off).
 *
 * @returns { distributableMinor, setOnMinor, setOffMinor }
 */
function computeSetOnSetOff({
  allocableSurplusMinor = null,
  totalMinBonusMinor,
  totalMaxBonusMinor,
  priorSetOnMinor = 0,
}) {
  if (allocableSurplusMinor == null) {
    return { distributableMinor: null, setOnMinor: 0, setOffMinor: 0, applicable: false };
  }
  const surplus = int(allocableSurplusMinor);
  const minB = int(totalMinBonusMinor);
  const maxB = int(totalMaxBonusMinor);
  const prior = int(priorSetOnMinor);

  let distributable = surplus;
  let setOn = 0;
  let setOff = 0;
  if (surplus > maxB) {
    // surplus exceeds the 20% ceiling → distribute the max, set-on the excess.
    distributable = maxB;
    setOn = surplus - maxB;
  } else if (surplus < minB) {
    // below the 8.33% floor → top up from prior set-on (set-off), still pay min.
    distributable = minB;
    setOff = Math.min(prior, minB - surplus);
  }
  return { distributableMinor: distributable, setOnMinor: setOn, setOffMinor: setOff, applicable: true };
}

/**
 * computeBonusCycle — the cycle orchestration core (the fnf.js parallel). PURE.
 * For each employee row (already resolved by the controller), determine
 * eligibility + compute the award, then roll the eligible net amounts into a
 * mint-ready `payRunInput` (type='BONUS') identical in shape to fnf.payRunInput.
 *
 * @param cycle      { accountingYearEnd, rateBasisPoints, minWageMonthlyMinor?,
 *                     allocableSurplusMinor?, priorSetOnMinor?, currencyCode? }
 * @param employees  [{ employeeId, monthlyBasicDaMinor, workedDays, eligibleMonths,
 *                       disqualifiedS9?, entityCovered?, advancePaidMinor? }]
 */
function computeBonusCycle(cycle, employees = []) {
  const params = resolveCycleParams({
    accountingYearEnd: cycle.accountingYearEnd,
    rateBasisPoints: cycle.rateBasisPoints,
    minWageMonthlyMinor: cycle.minWageMonthlyMinor,
  });
  const currencyCode = cycle.currencyCode || 'INR';

  const awards = [];
  const lines = [];
  let eligibleCount = 0;
  let ineligibleCount = 0;
  let totalGrossMinor = 0;
  let totalNetMinor = 0;
  let totalMinBonusMinor = 0;
  let totalMaxBonusMinor = 0;

  for (const emp of employees) {
    const verdict = determineBonusEligibility({
      monthlyBasicDaMinor: emp.monthlyBasicDaMinor,
      workedDays: emp.workedDays,
      disqualifiedS9: emp.disqualifiedS9 === true,
      entityCovered: emp.entityCovered !== false,
      params,
    });
    const award = computeBonusAward({
      monthlyBasicDaMinor: emp.monthlyBasicDaMinor,
      eligibleMonths: emp.eligibleMonths,
      advancePaidMinor: emp.advancePaidMinor,
      params,
      eligible: verdict.eligible,
      ineligibleReason: verdict.ineligibleReason,
    });

    awards.push({ employeeId: emp.employeeId, ...award });

    if (award.eligible) {
      eligibleCount += 1;
      totalGrossMinor += award.grossBonusMinor;
      totalNetMinor += award.netBonusMinor;
      // §10/§11 min & max bonus totals (for the set-on/set-off advisory only).
      const annualWageMinor = Math.round(award.cappedBaseMinor * award.eligibleMonths);
      totalMinBonusMinor += roundToRupeeNearest(pctExact(annualWageMinor, params.minRateNum, params.rateDen));
      totalMaxBonusMinor += roundToRupeeNearest(pctExact(annualWageMinor, params.maxRateNum, params.rateDen));

      // Mint-ready line — STAT_BONUS earning + optional advance deduction; the line
      // gross/net reconcile by construction (the same numbers the award froze).
      const earnings = [{
        code: 'STAT_BONUS',
        label: 'Statutory Bonus (Payment of Bonus Act 1965)',
        amountMinor: award.grossBonusMinor,
      }];
      const deductions = [];
      if (award.advancePaidMinor > 0) {
        deductions.push({
          code: 'BONUS_ADVANCE',
          label: 'Bonus advance / interim already paid',
          amountMinor: award.advancePaidMinor,
        });
      }
      lines.push({
        employeeId: emp.employeeId,
        earnings,
        deductions,
        grossMinor: award.grossBonusMinor,
        totalDeductionsMinor: award.advancePaidMinor,
        netMinor: award.netBonusMinor,
      });
    } else {
      ineligibleCount += 1;
    }
  }

  const grossMinor = lines.reduce((s, l) => s + l.grossMinor, 0);
  const totalDeductionsMinor = lines.reduce((s, l) => s + l.totalDeductionsMinor, 0);
  const netMinor = lines.reduce((s, l) => s + l.netMinor, 0);

  const setOnSetOff = computeSetOnSetOff({
    allocableSurplusMinor: cycle.allocableSurplusMinor,
    totalMinBonusMinor,
    totalMaxBonusMinor,
    priorSetOnMinor: cycle.priorSetOnMinor,
  });

  return {
    accountingYearEnd: cycle.accountingYearEnd,
    rateBasisPoints: params.rateBasisPoints,
    eligibilityCeilingMinor: params.eligibilityCeilingMinor,
    calcCeilingMinor: params.calcCeilingMinor,
    awards,
    totals: { eligibleCount, ineligibleCount, totalGrossMinor, totalNetMinor },
    // mint-ready, identical in shape to fnf.payRunInput so the controller mints a
    // PayRun(BONUS) through the SAME persist path the FnF controller uses.
    payRunInput: {
      type: 'BONUS',
      currencyCode,
      lines,
      grossMinor,
      totalDeductionsMinor,
      netMinor,
    },
    setOnSetOff, // §15/§16 advisory only
  };
}

module.exports = {
  INELIGIBLE,
  resolveCycleParams,
  determineBonusEligibility,
  computeBonusAward,
  computeSetOnSetOff,
  computeBonusCycle,
};
