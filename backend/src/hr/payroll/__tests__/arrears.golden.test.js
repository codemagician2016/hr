'use strict';

/*
 * arrears.golden.test.js — PURE golden-dataset test for the Feature 27 arrear math
 * seam (../arrears.js). Mirrors bonus.golden.test.js: NO jest, NO DB, plain-node
 * built-in assert; every expected value derived BY HAND from the rate/ceiling tables
 * in docs/05-compliance-india.md + the §89(1)/Form rules in docs/features/27.
 *
 *   node src/hr/payroll/__tests__/arrears.golden.test.js
 *
 * MONEY: INTEGER MINOR UNITS (paise). ₹1 = 100 paise.
 */

const assert = require('assert');
const A = require('../arrears');
const { _internals: india } = require('../compliance/india');

const P = 100;
const R = (rupees) => rupees * P;

let passed = 0;
let failed = 0;
const discrepancies = [];
function check(scenario, expected, actual) {
  try {
    assert.strictEqual(actual, expected);
    passed += 1;
  } catch (e) {
    failed += 1;
    const msg = `${scenario}: expected ${expected} got ${actual}`;
    discrepancies.push(msg);
    console.error(`FAIL  ${msg}`);
  }
}

// ── A. detectRetroWindow ────────────────────────────────────────────────────
// April increment processed in July → the elapsed paid months are Apr, May, Jun.
{
  const w = A.detectRetroWindow({ effectiveFrom: '2026-04-15', openPeriodStart: '2026-07-01' });
  check('A1 window length (Apr–Jun)', 3, w.length);
  check('A1 window[0]', '2026-04', w[0]);
  check('A1 window[2]', '2026-06', w[2]);
  // Non-retro: revision effective IN the open period → no arrears.
  check('A2 non-retro window empty', 0, A.detectRetroWindow({ effectiveFrom: '2026-07-01', openPeriodStart: '2026-07-01' }).length);
  // Future-dated revision → no arrears.
  check('A3 future window empty', 0, A.detectRetroWindow({ effectiveFrom: '2026-09-01', openPeriodStart: '2026-07-01' }).length);
  // Spanning a FY boundary: Jan effective, Apr open → Jan,Feb,Mar (3 months, prev FY).
  const fy = A.detectRetroWindow({ effectiveFrom: '2026-01-10', openPeriodStart: '2026-04-01' });
  check('A4 FY-spanning window length', 3, fy.length);
  check('A4 FY-spanning window[0]', '2026-01', fy[0]);
}

// ── B. diffMonth — per-component delta to the paise ──────────────────────────
// Old slip (frozen snapshot, MAJOR units): Basic 10000, HRA 5000, gross 15000.
// New recompute (engine, MINOR units): Basic 14000, HRA 5000, gross 19000.
// Δ gross = 4000; Basic Δ = +4000; HRA Δ = 0 (dropped from componentDeltas).
{
  const frozen = {
    gross: '15000.00',
    earnings: [{ code: 'BASIC', label: 'Basic', amount: '10000.00' }, { code: 'HRA', label: 'HRA', amount: '5000.00' }],
    bases: { pfWagesFlaggedMinor: R(10000), esiWagesMinor: R(15000) },
  };
  const recomputed = {
    grossMinor: R(19000),
    earnings: [{ code: 'BASIC', label: 'Basic', amountMinor: R(14000) }, { code: 'HRA', label: 'HRA', amountMinor: R(5000) }],
    bases: { pfWagesFlaggedMinor: R(14000), esiWagesMinor: R(19000) },
  };
  const d = A.diffMonth({ recomputed, paid: frozen, paidShape: 'snapshot' });
  check('B1 deltaGross = 4000', R(4000), d.deltaGrossMinor);
  check('B2 deltaPfWage = 4000', R(4000), d.deltaPfWageMinor);
  check('B3 deltaEsiWage = 4000', R(4000), d.deltaEsiWageMinor);
  check('B4 only BASIC moved (1 component delta)', 1, d.componentDeltas.length);
  check('B5 BASIC delta code', 'BASIC', d.componentDeltas[0].code);
  check('B6 BASIC delta = +4000', R(4000), d.componentDeltas[0].deltaMinor);
}

// ── C. aggregateArrear — 3×₹4,000 increment, PF/ESI below ceiling ───────────
// Apr increment Basic +4000 (old 10000 → new 14000); 3 months no LOP.
// PF EE = 12% of 4000 = 480/mo → 1440 total. ESI EE delta: old 18000→135, new 22000→165
//   (latched covered), delta 30/mo → 90 total.
{
  const months = ['2026-04', '2026-05', '2026-06'].map((p) => ({
    sourcePeriod: p, deltaGrossMinor: R(4000),
    oldPfWageMinor: R(10000), newPfWageMinor: R(14000),
    oldEsiWageMinor: R(18000), newEsiWageMinor: R(22000), esiLatchedCovered: true,
  }));
  const agg = A.aggregateArrear({ months, esiOnArrears: true, india });
  check('C1 grossArrear = 3×4000 = 12000', R(12000), agg.grossArrearMinor);
  check('C2 pfArrearEe = 3×480 = 1440', R(1440), agg.pfArrearEeMinor);
  check('C3 esiArrearEe = 3×30 = 90', R(90), agg.esiArrearEeMinor);
}

// ── D. at-PF-ceiling source month → ₹0 incremental PF ────────────────────────
// Old PF wage already ≥ ₹15,000 → both old & new cap at 15,000 → 0 incremental PF.
{
  const agg = A.aggregateArrear({
    months: [{ sourcePeriod: '2026-04', deltaGrossMinor: R(4000), oldPfWageMinor: R(16000), newPfWageMinor: R(20000) }],
    esiOnArrears: false, india,
  });
  check('D1 at-ceiling pfArrearEe = 0', 0, agg.pfArrearEeMinor);
  check('D2 at-ceiling gross arrear still full', R(4000), agg.grossArrearMinor);
}

// ── E. ESI reason gate — settlement (RESTRUCTURE) → ESI arrear = 0 ────────────
{
  check('E1 ANNUAL_REVISION → ESI on', true, A.esiOnArrearsDefault('ANNUAL_REVISION'));
  check('E2 PROMOTION → ESI on', true, A.esiOnArrearsDefault('PROMOTION'));
  check('E3 RESTRUCTURE → ESI off', false, A.esiOnArrearsDefault('RESTRUCTURE'));
  check('E4 STATUTORY_ADJUSTMENT → ESI off', false, A.esiOnArrearsDefault('STATUTORY_ADJUSTMENT'));
  const agg = A.aggregateArrear({
    months: [{ sourcePeriod: '2026-04', deltaGrossMinor: R(4000), oldPfWageMinor: R(10000), newPfWageMinor: R(14000), oldEsiWageMinor: R(18000), newEsiWageMinor: R(22000) }],
    esiOnArrears: false, india,
  });
  check('E5 esiOnArrears=false → esiArrearEe = 0', 0, agg.esiArrearEeMinor);
  check('E6 esiOnArrears=false → esiArrearEr = 0', 0, agg.esiArrearErMinor);
}

// ── F. mid-window LOP — a fully-LOP month yields ₹0 arrear (frozen attendance) ──
// Modelled at the aggregate seam: a month whose recompute = frozen (no delta) → ₹0.
{
  const months = [
    { sourcePeriod: '2026-04', deltaGrossMinor: R(4000), oldPfWageMinor: R(10000), newPfWageMinor: R(14000) }, // worked
    { sourcePeriod: '2026-05', deltaGrossMinor: 0, oldPfWageMinor: 0, newPfWageMinor: 0 },                      // fully LOP
    { sourcePeriod: '2026-06', deltaGrossMinor: R(4000), oldPfWageMinor: R(10000), newPfWageMinor: R(14000) },  // worked
  ];
  const agg = A.aggregateArrear({ months, esiOnArrears: false, india });
  check('F1 LOP month drops out → 2×4000 = 8000', R(8000), agg.grossArrearMinor);
  check('F2 LOP month → 2×480 PF only = 960', R(960), agg.pfArrearEeMinor);
}

// ── G. resolveReliefFormName — Form 10E (≤FY2025-26) vs Form 39 (≥FY2026-27) ──
{
  check('G1 FY2024-25 → Form 10E', 'Form 10E', A.resolveReliefFormName('2024-25'));
  check('G2 FY2025-26 → Form 10E (last 10E year)', 'Form 10E', A.resolveReliefFormName('2025-26'));
  check('G3 FY2026-27 → Form 39 (renumber)', 'Form 39', A.resolveReliefFormName('2026-27'));
  check('G4 FY2030-31 → Form 39', 'Form 39', A.resolveReliefFormName('2030-31'));
}

// ── H. computeS89Relief — non-negative + source slab lower → positive relief ──
{
  // Same slab both years → relief 0 (extra tax now == tax-had-it-been-then).
  const flat = A.computeS89Relief({ india, receiptFY: '2026-27', receiptYearOtherTaxableRupees: 1500000, arrearRupees: 100000, sourceSlices: [{ fy: '2025-26', otherTaxableRupees: 1400000, sliceRupees: 100000 }] });
  check('H1 relief non-negative (flat-slab)', true, flat.reliefMinor >= 0);
  check('H2 form name on datapoint', 'Form 39', flat.datapoint.formName);
  // Source year low slab, receipt year high → relief > 0 (the whole point of §89(1)).
  const pos = A.computeS89Relief({ india, receiptFY: '2026-27', receiptYearOtherTaxableRupees: 3000000, arrearRupees: 200000, sourceSlices: [{ fy: '2025-26', otherTaxableRupees: 800000, sliceRupees: 200000 }] });
  check('H3 positive relief when source slab lower', true, pos.reliefMinor > 0);
  check('H4 step1 > 0 (extra tax in receipt year)', true, pos.datapoint.step1ReceiptExtraTaxMinor > 0);
  check('H5 per-source-FY attribution present', 1, pos.datapoint.sourceSlices.length);
  check('H6 source slice FY = 2025-26', '2025-26', pos.datapoint.sourceSlices[0].fy);
}

// ── I. downward (negative) revision → negative arrear surfaced (not floored) ──
{
  const months = [{ sourcePeriod: '2026-04', deltaGrossMinor: R(-2000), oldPfWageMinor: R(14000), newPfWageMinor: R(12000) }];
  const agg = A.aggregateArrear({ months, esiOnArrears: false, india });
  check('I1 negative gross arrear surfaced', R(-2000), agg.grossArrearMinor);
  // PF is floored at 0 (we never auto-claw PF on a downward revision; recovery is gated).
  check('I2 downward PF not negative (floored 0)', 0, agg.pfArrearEeMinor);
}

console.log('');
console.log(`Arrears golden test: ${passed} passed, ${failed} failed of ${passed + failed} assertions.`);
if (failed > 0) {
  console.log('Discrepancies:');
  for (const d of discrepancies) console.log('  - ' + d);
  process.exitCode = 1;
}
