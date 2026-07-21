'use strict';

/**
 * latePenalty.js — Program P1.5: PURE late-coming penalty math.
 *
 * The India-common policy: `allowedLatesPerMonth` lates are free; after that,
 * every `perLates` further lates cost `penaltyDayFraction` of a day, applied ON
 * the offending late day (so the muster shows exactly which day was penalised).
 *
 * computeLatePenalties(dayRows, rule) → Map<dateKey, penaltyFraction>
 *   - dayRows: that MONTH's attendance rows [{ date, lopFraction, exceptionsJson }]
 *     (any order; only rows whose exceptions flag LATE_IN count as lates).
 *   - returns the penalty for EVERY late day (0 when unpenalised) so the caller
 *     can idempotently reconcile: stored penalty ≠ computed penalty → rewrite.
 *
 * Idempotency contract with the caller: the previously-applied penalty is
 * recorded at exceptionsJson.latePenalty; base LOP = lopFraction − stored
 * penalty; new lopFraction = min(1, base + computed penalty). Recomputing from
 * scratch each pass means punch edits / regularizations that remove a LATE_IN
 * automatically shift or remove downstream penalties.
 */

function dateKey(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

function isLate(row) {
  const ex = row && row.exceptionsJson;
  const flags = ex && Array.isArray(ex.flags) ? ex.flags : [];
  return flags.includes('LATE_IN');
}

function computeLatePenalties(dayRows, rule) {
  const out = new Map();
  if (!rule || rule.isActive === false) return out;
  const allowed = Number(rule.allowedLatesPerMonth);
  const per = Math.max(1, Number(rule.perLates) || 1);
  const fraction = Number(rule.penaltyDayFraction);
  if (!Number.isFinite(allowed) || !Number.isFinite(fraction) || fraction <= 0) return out;

  const lates = (dayRows || [])
    .filter(isLate)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  lates.forEach((row, idx) => {
    const nth = idx + 1; // 1-based late count within the month
    let penalty = 0;
    if (nth > allowed) {
      // Penalise the day that COMPLETES each perLates block beyond the allowance.
      const over = nth - allowed;
      if (over % per === 0) penalty = fraction;
    }
    out.set(dateKey(row.date), penalty);
  });
  return out;
}

module.exports = { computeLatePenalties, isLate, dateKey };
