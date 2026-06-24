'use strict';

/**
 * arrears.js — Feature 27 PURE arrear math seam (no DB, no I/O).
 *
 * The unit-testable core of the auto-arrear engine, mirroring payroll/bonus.js:
 * every function here is deterministic, integer-paise, and consults ONLY its
 * arguments. The DB-touching twin is arrears.service.js (mirrors bonus.service.js).
 *
 * WHAT IT DOES
 *   When a CompensationRevision is effective-dated in the PAST (an April increment
 *   processed in July), the already-paid, FROZEN payslips for the elapsed months
 *   were computed on the OLD comp. The shortfall is ARREARS. This module:
 *     - detectRetroWindow : enumerates the elapsed, already-paid source months.
 *     - diffMonth         : per-component delta = recomputed − paid (matched by code),
 *                           plus gross / PF-wage / ESI-wage base deltas, to the paise.
 *     - aggregateArrear   : Σ deltas + PF/ESI on the arrear computed PER SOURCE MONTH
 *                           (so the ₹15,000 PF ceiling / ₹21,000 ESI cap apply to
 *                           THAT month's true wage, not the payout month).
 *     - computeS89Relief  : the Section 89(1) relief data point (the 6-step arithmetic).
 *     - resolveReliefFormName : effective-dated "Form 10E" (≤FY2025-26) vs "Form 39"
 *                           (≥FY2026-27), mirroring india.calendar.js resolveVersion.
 *
 * STATUTORY TRUTH (single source): PF/ESI on the arrear is computed by calling the
 * SAME compliance/india.js primitives (computeEpf / computeEsi) the live engine uses.
 * We pass the per-source-month wage (OLD vs NEW) and take the INCREMENTAL difference,
 * so a month already at the PF ceiling yields ₹0 incremental PF automatically.
 *
 * MONEY: all amounts are INTEGER MINOR UNITS (paise). ₹1 = 100 paise.
 */

// ── month-code helpers (a "YYYY-MM" period code) ──────────────────────────────
/** "YYYY-MM" of a Date (UTC). */
function periodCodeOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
/** First-of-month Date (UTC) for a "YYYY-MM" code. */
function monthStart(code) {
  const [y, m] = String(code).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1));
}
/** Last-of-month Date (UTC, the month-end) for a "YYYY-MM" code. */
function monthEnd(code) {
  const [y, m] = String(code).split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this month
}
/** The next "YYYY-MM" after a code. */
function nextCode(code) {
  const [y, m] = String(code).split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * detectRetroWindow({ effectiveFrom, openPeriodStart })
 *   → ["YYYY-MM", ...]  the elapsed, already-paid months in [effectiveFrom, openPeriod).
 *
 * The window is INCLUSIVE of the effective-from month and EXCLUSIVE of the open
 * (current) period — those months are already frozen/paid on the OLD comp. A
 * non-retro (current or future) revision yields an EMPTY window → NO arrears.
 *
 * @param {Date|string} effectiveFrom    the revision retro date
 * @param {Date|string} openPeriodStart  first day of the open (current) run's period
 * @returns {string[]} ascending "YYYY-MM" codes
 */
function detectRetroWindow({ effectiveFrom, openPeriodStart }) {
  if (!effectiveFrom || !openPeriodStart) return [];
  const fromCode = periodCodeOf(effectiveFrom);
  const openCode = periodCodeOf(openPeriodStart);
  // Nothing retro if the revision starts in or after the open period.
  if (fromCode >= openCode) return [];
  const months = [];
  let cur = fromCode;
  // Guard against a runaway loop (max 60 months of retro).
  for (let i = 0; i < 60 && cur < openCode; i += 1) {
    months.push(cur);
    cur = nextCode(cur);
  }
  return months;
}

// ── snapshot adapters ─────────────────────────────────────────────────────────
// The FROZEN baseline arrives as a Payslip.snapshotJson (amounts in MAJOR units,
// rupees with 2 decimals) OR as a computePayslip-shaped result (amounts in MINOR
// units). diffMonth normalises both to a paise map keyed by component code.

function majorToMinor(major) {
  // "1234.56" / 1234.56 → 123456 (paise). Integer-exact via string parse.
  if (major == null) return 0;
  const n = typeof major === 'number' ? major : Number(major);
  return Math.round(n * 100);
}

/**
 * Normalise either a frozen snapshot (major units) or an engine result (minor
 * units) to { grossMinor, pfWageMinor, esiWageMinor, components: Map<code,minor> }.
 * `shape` is 'snapshot' (major) or 'engine' (minor).
 */
function normalisePayslip(p, shape) {
  const isSnap = shape === 'snapshot';
  const earnings = p.earnings || [];
  const components = new Map();
  for (const e of earnings) {
    const code = e.code;
    const minor = isSnap ? majorToMinor(e.amount) : Math.round(Number(e.amountMinor) || 0);
    components.set(code, (components.get(code) || 0) + minor);
  }
  // Gross + statutory bases.
  let grossMinor;
  let pfWageMinor;
  let esiWageMinor;
  if (isSnap) {
    grossMinor = majorToMinor(p.gross);
    const bases = p.bases || {};
    pfWageMinor = Math.round(Number(bases.pfWagesFlaggedMinor) || 0);
    esiWageMinor = Math.round(Number(bases.esiWagesMinor) || 0);
  } else {
    grossMinor = Math.round(Number(p.grossMinor) || 0);
    const bases = p.bases || {};
    pfWageMinor = Math.round(Number(bases.pfWagesFlaggedMinor) || 0);
    esiWageMinor = Math.round(Number(bases.esiWagesMinor) || 0);
  }
  return { grossMinor, pfWageMinor, esiWageMinor, components };
}

/**
 * diffMonth({ recomputed, paid })
 *   recomputed : a computePayslip RESULT (minor units) at the NEW comp.
 *   paid       : the FROZEN paid Payslip.snapshotJson (major units) OR an engine
 *                result (minor units) — pass paidShape:'engine' to force minor.
 *   → { deltaGrossMinor, deltaPfWageMinor, deltaEsiWageMinor, componentDeltas[],
 *       paidGrossMinor, recomputedGrossMinor,
 *       paidPfWageMinor, recomputedPfWageMinor,
 *       paidEsiWageMinor, recomputedEsiWageMinor }
 *
 * Per-component delta = recomputed.amount − paid.amount, matched by code. A code
 * present in only one side contributes its full (signed) amount. All paise-exact.
 */
function diffMonth({ recomputed, paid, paidShape = 'snapshot' }) {
  const rec = normalisePayslip(recomputed, 'engine');
  const pay = normalisePayslip(paid, paidShape);

  const codes = new Set([...rec.components.keys(), ...pay.components.keys()]);
  const componentDeltas = [];
  for (const code of codes) {
    const recAmt = rec.components.get(code) || 0;
    const payAmt = pay.components.get(code) || 0;
    const deltaMinor = recAmt - payAmt;
    if (deltaMinor === 0) continue; // only surface components that actually moved
    componentDeltas.push({
      code,
      label: labelFor(recomputed, paid, code),
      recomputedMinor: recAmt,
      paidMinor: payAmt,
      deltaMinor,
    });
  }
  // Deterministic order for snapshots/tests.
  componentDeltas.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  return {
    deltaGrossMinor: rec.grossMinor - pay.grossMinor,
    deltaPfWageMinor: rec.pfWageMinor - pay.pfWageMinor,
    deltaEsiWageMinor: rec.esiWageMinor - pay.esiWageMinor,
    paidGrossMinor: pay.grossMinor,
    recomputedGrossMinor: rec.grossMinor,
    paidPfWageMinor: pay.pfWageMinor,
    recomputedPfWageMinor: rec.pfWageMinor,
    paidEsiWageMinor: pay.esiWageMinor,
    recomputedEsiWageMinor: rec.esiWageMinor,
    componentDeltas,
  };
}

/** Best-effort component label from either side. */
function labelFor(recomputed, paid, code) {
  const r = (recomputed.earnings || []).find((e) => e.code === code);
  if (r && r.label) return r.label;
  const p = (paid.earnings || []).find((e) => e.code === code);
  if (p && p.label) return p.label;
  return code;
}

/**
 * pfArrearForMonth({ india, oldPfWageMinor, newPfWageMinor, capAtCeiling })
 *   → { eeMinor, erMinor } incremental PF on the arrear FOR ONE SOURCE MONTH (SIGNED).
 *
 * Computed as computeEpf(new) − computeEpf(old): the ₹15,000 ceiling is applied to
 * the SOURCE month's full wage inside computeEpf, so a month whose OLD wage was
 * already ≥ ceiling yields ZERO incremental PF (the cap binds on both sides). er =
 * the A/c1 employer-EPF balance delta (EPS/EDLI/admin are establishment-level and
 * NOT charged incrementally on a single employee's arrear).
 *
 * FIX (finding #4): the per-month delta is SIGNED — a DOWN-revision month (PF wage
 * dropped) returns a NEGATIVE delta so it nets against the up-months at the aggregate
 * seam (the ONLY place the total is floored, see aggregateArrear). Flooring HERE (per
 * month) over-billed PF on a MIXED up/down cycle: down-months silently contributed 0
 * instead of reducing the total, so EPF remitted to EPFO exceeded the PF on the true
 * net arrear. The `Math.max(0, …)` on the WAGE inputs is kept — a wage base is never
 * negative; only the EE/ER DELTA may be.
 *
 * @param {Object} india  the india._internals namespace (computeEpf)
 */
function pfArrearForMonth({ india, oldPfWageMinor, newPfWageMinor, capAtCeiling = true }) {
  const oldEpf = india.computeEpf({ pfWageMinor: Math.max(0, oldPfWageMinor), capAtCeiling });
  const newEpf = india.computeEpf({ pfWageMinor: Math.max(0, newPfWageMinor), capAtCeiling });
  return {
    eeMinor: newEpf.epfEeMinor - oldEpf.epfEeMinor,
    erMinor: newEpf.epfErMinor - oldEpf.epfErMinor,
  };
}

/**
 * esiArrearForMonth({ india, oldEsiWageMinor, newEsiWageMinor, latchedCovered })
 *   → { eeMinor, erMinor } incremental ESI on the arrear FOR ONE SOURCE MONTH (SIGNED).
 *
 * Computed as computeEsi(new) − computeEsi(old). The contribution-period latch is
 * honoured: a month that was COVERED stays covered for the arrear even if the
 * revised gross now crosses ₹21,000 (coverage continuity, §2). Pass latchedCovered
 * = the source month's frozen coverage verdict.
 *
 * FIX (finding #4): SIGNED, same as pfArrearForMonth — a down-ESI-wage month nets
 * against the up-months at the aggregate seam rather than being asymmetrically dropped.
 */
function esiArrearForMonth({ india, oldEsiWageMinor, newEsiWageMinor, latchedCovered = true }) {
  const oldEsi = india.computeEsi({ esiGrossMinor: Math.max(0, oldEsiWageMinor), latchedCovered });
  const newEsi = india.computeEsi({ esiGrossMinor: Math.max(0, newEsiWageMinor), latchedCovered });
  return {
    eeMinor: newEsi.esiEeMinor - oldEsi.esiEeMinor,
    erMinor: newEsi.esiErMinor - oldEsi.esiErMinor,
  };
}

/**
 * aggregateArrear({ months, esiOnArrears, india })
 *   months : [{ sourcePeriod, deltaGrossMinor,
 *               oldPfWageMinor, newPfWageMinor,
 *               oldEsiWageMinor, newEsiWageMinor, esiLatchedCovered }, ...]
 *   → { grossArrearMinor, pfArrearEeMinor, pfArrearErMinor,
 *       esiArrearEeMinor, esiArrearErMinor, perMonth[] }
 *
 * PF on Σ deltaPfWage is computed PER SOURCE MONTH (the ₹15,000-ceiling logic
 * applies to that month additively). ESI on Σ deltaEsiWage only if esiOnArrears
 * (the revisionReason gate resolved by the caller).
 *
 * FIX (finding #4): per-month PF/ESI deltas are accumulated SIGNED (up-months +,
 * down-months −) and the AGGREGATE is floored at 0 — never each month independently.
 * This nets a mixed up/down cycle correctly (a small allowance cut in one month
 * reduces the PF billed on the bigger basic raise in another) so EPF/ESI charged on
 * the arrear is consistent with the net gross delta paid. The aggregate floor at 0
 * preserves the "never auto-claw statutory back" rule: a NET-negative statutory cycle
 * yields 0 here and the net-negative GROSS is gated as a recovery at approve.
 */
function aggregateArrear({ months, esiOnArrears, india }) {
  let grossArrearMinor = 0;
  // Signed running sums — floored only AFTER the loop (the aggregate seam).
  let pfArrearEeSigned = 0;
  let pfArrearErSigned = 0;
  let esiArrearEeSigned = 0;
  let esiArrearErSigned = 0;
  const perMonth = [];

  for (const m of months || []) {
    grossArrearMinor += Math.round(Number(m.deltaGrossMinor) || 0);

    const pf = pfArrearForMonth({
      india,
      oldPfWageMinor: Math.round(Number(m.oldPfWageMinor) || 0),
      newPfWageMinor: Math.round(Number(m.newPfWageMinor) || 0),
      capAtCeiling: m.pfCapAtCeiling !== false,
    });
    pfArrearEeSigned += pf.eeMinor;
    pfArrearErSigned += pf.erMinor;

    let esi = { eeMinor: 0, erMinor: 0 };
    if (esiOnArrears) {
      esi = esiArrearForMonth({
        india,
        oldEsiWageMinor: Math.round(Number(m.oldEsiWageMinor) || 0),
        newEsiWageMinor: Math.round(Number(m.newEsiWageMinor) || 0),
        latchedCovered: m.esiLatchedCovered !== false,
      });
    }
    esiArrearEeSigned += esi.eeMinor;
    esiArrearErSigned += esi.erMinor;

    // perMonth keeps the SIGNED per-month figure (the audit trail must show the true
    // down-month reduction); the cycle TOTAL below is the floored aggregate.
    perMonth.push({
      sourcePeriod: m.sourcePeriod,
      deltaGrossMinor: Math.round(Number(m.deltaGrossMinor) || 0),
      pfEeMinor: pf.eeMinor,
      pfErMinor: pf.erMinor,
      esiEeMinor: esi.eeMinor,
      esiErMinor: esi.erMinor,
    });
  }

  return {
    grossArrearMinor,
    // Floor the AGGREGATE (not each month): up/down months have already netted.
    pfArrearEeMinor: Math.max(0, pfArrearEeSigned),
    pfArrearErMinor: Math.max(0, pfArrearErSigned),
    esiArrearEeMinor: Math.max(0, esiArrearEeSigned),
    esiArrearErMinor: Math.max(0, esiArrearErSigned),
    perMonth,
  };
}

// ── ESI-on-arrears reason gate (§2) ───────────────────────────────────────────
// Late incremental arrears (a periodic/annual increment declared late) are
// CHARGEABLE to ESI; arrears of a retrospective wage-revision SETTLEMENT/agreement
// are NOT. We gate on CompensationRevision.revisionReason.
const ESI_CHARGEABLE_REASONS = new Set(['ANNUAL_REVISION', 'PROMOTION', 'CORRECTION', 'HIRE']);
const ESI_EXEMPT_REASONS = new Set(['RESTRUCTURE', 'STATUTORY_ADJUSTMENT']);

/** Default esiOnArrears from the revision reason (operator-overridable). */
function esiOnArrearsDefault(revisionReason) {
  if (ESI_EXEMPT_REASONS.has(revisionReason)) return false;
  // Fail-OPEN to charging for any chargeable/unknown reason (the safer statutory side).
  return true;
}

// ── Section 89(1) relief data point (§2) ─────────────────────────────────────
/**
 * computeS89Relief({ india, receiptFY, receiptYearOtherTaxableRupees, arrearRupees,
 *                    sourceSlices })
 *   sourceSlices : [{ fy, otherTaxableRupees, sliceRupees }, ...]
 *     one slice per SOURCE financial year the arrear relates to. otherTaxableRupees
 *     = that year's already-assessed taxable income (excl. the slice).
 *
 * The 6-step §89(1) arithmetic (all amounts via annualTaxNewRegime, integer paise):
 *   A = tax(receipt FY incl. WHOLE arrear)
 *   B = tax(receipt FY excl. arrear)
 *   step1 = A − B                                  (extra tax on receipt because of arrear)
 *   step2 = Σ_fy [ tax(fy incl. its slice) − tax(fy excl. its slice) ]   (had-it-been-taxed-then)
 *   relief = max(0, step1 − step2)
 *
 * → { reliefMinor, datapoint } where datapoint carries every intermediate figure
 *    (paise) for the Form 10E / 39 worksheet + ESS explainer.
 */
function computeS89Relief({ india, receiptFY, receiptYearOtherTaxableRupees, arrearRupees, sourceSlices }) {
  const taxOf = (rupees) => india.annualTaxNewRegime(Math.max(0, Math.round(rupees))).totalAnnualTaxMinor;

  const taxReceiptWithMinor = taxOf(receiptYearOtherTaxableRupees + arrearRupees);
  const taxReceiptWithoutMinor = taxOf(receiptYearOtherTaxableRupees);
  const step1Minor = Math.max(0, taxReceiptWithMinor - taxReceiptWithoutMinor);

  const slices = [];
  let step2Minor = 0;
  for (const s of sourceSlices || []) {
    const withMinor = taxOf((s.otherTaxableRupees || 0) + (s.sliceRupees || 0));
    const withoutMinor = taxOf(s.otherTaxableRupees || 0);
    const sliceTaxMinor = Math.max(0, withMinor - withoutMinor);
    step2Minor += sliceTaxMinor;
    slices.push({
      fy: s.fy,
      sliceRupees: Math.round(s.sliceRupees || 0),
      otherTaxableRupees: Math.round(s.otherTaxableRupees || 0),
      taxWithSliceMinor: withMinor,
      taxWithoutSliceMinor: withoutMinor,
      sliceTaxMinor,
    });
  }

  const reliefMinor = Math.max(0, step1Minor - step2Minor);

  return {
    reliefMinor,
    datapoint: {
      receiptFY,
      formName: resolveReliefFormName(receiptFY),
      arrearRupees: Math.round(arrearRupees),
      receiptYearOtherTaxableRupees: Math.round(receiptYearOtherTaxableRupees),
      taxReceiptWithMinor,
      taxReceiptWithoutMinor,
      step1ReceiptExtraTaxMinor: step1Minor,
      step2SourceYearTaxMinor: step2Minor,
      reliefMinor,
      sourceSlices: slices,
    },
  };
}

// ── Form 10E / Form 39 effective-dated name resolver (§2) ─────────────────────
// Form 10E is renumbered Form 39 under the Income-Tax Act 2025 / Rules 2026,
// effective 1 Apr 2026. The receipt FY drives the name: ≤ FY2025-26 → "Form 10E";
// ≥ FY2026-27 → "Form 39". Mirrors india.calendar.js's effective-dated resolver:
// we resolve by the FY's END date (31-Mar of the second year).
const RELIEF_FORM_VERSIONS = [
  { effectiveFrom: '1900-01-01', effectiveTo: '2026-03-31', formName: 'Form 10E' },
  { effectiveFrom: '2026-04-01', effectiveTo: null, formName: 'Form 39' },
];

/** "2026-27" (or "2026-2027") → its FY-end ISO date "2027-03-31". */
function fyEndIso(fyLabel) {
  const m = String(fyLabel || '').match(/^(\d{4})-(\d{2,4})$/);
  if (!m) return null;
  const startY = Number(m[1]);
  return `${startY + 1}-03-31`;
}

/** Resolve the relief form name for a receipt FY ("Form 10E" vs "Form 39"). */
function resolveReliefFormName(receiptFY) {
  const asOf = fyEndIso(receiptFY);
  if (!asOf) return 'Form 10E';
  let chosen = null;
  for (const v of RELIEF_FORM_VERSIONS) {
    if (asOf >= v.effectiveFrom && (!v.effectiveTo || asOf <= v.effectiveTo)) {
      if (!chosen || v.effectiveFrom > chosen.effectiveFrom) chosen = v;
    }
  }
  return chosen ? chosen.formName : 'Form 10E';
}

module.exports = {
  detectRetroWindow,
  diffMonth,
  aggregateArrear,
  pfArrearForMonth,
  esiArrearForMonth,
  computeS89Relief,
  resolveReliefFormName,
  esiOnArrearsDefault,
  // helpers exported for the service + tests
  periodCodeOf,
  monthStart,
  monthEnd,
  nextCode,
  fyEndIso,
  ESI_CHARGEABLE_REASONS,
  ESI_EXEMPT_REASONS,
};
