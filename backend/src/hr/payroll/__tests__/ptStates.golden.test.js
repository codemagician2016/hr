'use strict';

/*
 * ptStates.golden.test.js — Feature 43: golden checks for the 9 PT states added
 * for multi-state completeness (CG, PB, SK, TR, MZ, NL, MN, ML, PY) + the
 * PT_STATE_UNMAPPED anomaly + the no-PT allow-list. Hand-derived expecteds with
 * arithmetic shown; annual-slab states verify the Feb true-up sums to the exact
 * ANNUAL statute amount. Sources: taxguru.in state-wise table (2024-25, unchanged
 * FY2025-26) × greythr.com/wiki levy list, verified 2026-07-20.
 *
 * Plain-node:  node backend/src/hr/payroll/__tests__/ptStates.golden.test.js
 */

const assert = require('assert');
const IN = require('../compliance/india.js');

const P = 100;
const R = (rupees) => rupees * P;
const { computeProfessionalTax } = IN._internals;

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
}

// Annual total for a monthly-frequency state at a fixed monthly gross.
function annualTotal(stateCode, monthlyRupees, opts = {}) {
  let total = 0;
  for (let m = 1; m <= 12; m += 1) {
    const r = computeProfessionalTax({
      stateCode, ptGrossMinor: R(monthlyRupees), gender: opts.gender || 'MALE',
      month: m, asOf: new Date('2026-07-15'),
    });
    total += r.amountMinor;
  }
  return total;
}

/* ── CG: annual slabs divide evenly; ₹9,000/mo (₹1.08L/yr) → ₹1,440/yr = 120/mo ── */
ok('CG ₹9,000/mo → ₹120/mo', computeProfessionalTax({ stateCode: 'CG', ptGrossMinor: R(9000), month: 5, asOf: new Date('2026-07-15') }).amountMinor === R(120));
ok('CG annual at ₹9,000/mo = ₹1,440', annualTotal('CG', 9000) === R(1440));
ok('CG top band annual = ₹2,400', annualTotal('CG', 60000) === R(2400));
ok('CG ₹3,000/mo → nil', computeProfessionalTax({ stateCode: 'CG', ptGrossMinor: R(3000), month: 5, asOf: new Date() }).amountMinor === 0);

/* ── PB: flat ₹200 above ₹20,833/mo; nil below ────────────────────────────── */
ok('PB ₹30,000/mo → ₹200', computeProfessionalTax({ stateCode: 'PB', ptGrossMinor: R(30000), month: 6, asOf: new Date() }).amountMinor === R(200));
ok('PB ₹18,000/mo → nil', computeProfessionalTax({ stateCode: 'PB', ptGrossMinor: R(18000), month: 6, asOf: new Date() }).amountMinor === 0);
ok('PB annual = ₹2,400', annualTotal('PB', 30000) === R(2400));

/* ── SK / TR / MZ / NL: monthly slabs, annual under cap ───────────────────── */
ok('SK ₹25,000 → ₹125', computeProfessionalTax({ stateCode: 'SK', ptGrossMinor: R(25000), month: 3, asOf: new Date() }).amountMinor === R(125));
ok('SK ₹45,000 annual = ₹2,400', annualTotal('SK', 45000) === R(2400));
ok('TR ₹10,000 → ₹150', computeProfessionalTax({ stateCode: 'TR', ptGrossMinor: R(10000), month: 9, asOf: new Date() }).amountMinor === R(150));
ok('TR ₹20,000 annual = ₹2,496', annualTotal('TR', 20000) === R(2496));
ok('MZ ₹9,000 → ₹120', computeProfessionalTax({ stateCode: 'MZ', ptGrossMinor: R(9000), month: 1, asOf: new Date() }).amountMinor === R(120));
ok('MZ ₹16,000 annual = ₹2,496', annualTotal('MZ', 16000) === R(2496));
ok('NL ₹4,500 → ₹35', computeProfessionalTax({ stateCode: 'NL', ptGrossMinor: R(4500), month: 4, asOf: new Date() }).amountMinor === R(35));
ok('NL ₹13,000 annual = ₹2,496', annualTotal('NL', 13000) === R(2496));

/* ── MN: annual-slab with Feb true-up. ₹8,000/mo (₹96k/yr → ₹2,000/yr band):
 *     166×11 + 174 (Feb) = 1,826 + 174 = ₹2,000 exactly. ───────────────────── */
ok('MN ₹8,000 normal month → ₹166', computeProfessionalTax({ stateCode: 'MN', ptGrossMinor: R(8000), month: 5, asOf: new Date() }).amountMinor === R(166));
ok('MN ₹8,000 Feb → ₹174', computeProfessionalTax({ stateCode: 'MN', ptGrossMinor: R(8000), month: 2, asOf: new Date() }).amountMinor === R(174));
ok('MN ₹8,000 annual = ₹2,000 exact', annualTotal('MN', 8000) === R(2000));
ok('MN top band annual = ₹2,500 (208×11+212)', annualTotal('MN', 20000) === R(2500));

/* ── ML: annual-slab with true-ups; every band must hit the statute's ANNUAL sum ── */
const ML_BANDS = [
  [5000, 200], [7000, 300], [10000, 500], [14000, 750], [18000, 1000],
  [22000, 1250], [27000, 1500], [31000, 1800], [35000, 2100], [40000, 2400], [50000, 2500],
];
for (const [monthly, annual] of ML_BANDS) {
  ok(`ML ₹${monthly}/mo annual = ₹${annual}`, annualTotal('ML', monthly) === R(annual));
}
ok('ML ₹4,000/mo → nil', annualTotal('ML', 4000) === 0);

/* ── PY: half-yearly (TN-style). ₹2.5L half-year → ₹500; ₹6L → ₹1,250 ─────── */
{
  const r = computeProfessionalTax({ stateCode: 'PY', ptGrossMinor: R(250000), month: 9, asOf: new Date() });
  ok('PY ₹2.5L half-year → ₹500', r.amountMinor === R(500) && r.frequency === 'HALF_YEARLY');
  ok('PY ₹6L half-year → ₹1,250', computeProfessionalTax({ stateCode: 'PY', ptGrossMinor: R(600000), month: 3, asOf: new Date() }).amountMinor === R(1250));
}

/* ── Art. 276 cap sanity: EVERY configured state's worst case ≤ ₹2,500/yr ──── */
for (const st of Object.keys(IN.rules.professionalTax.states)) {
  const cfg = IN.rules.professionalTax.states[st];
  if (cfg.frequency === 'HALF_YEARLY') continue; // slab max ×2 ≤ 2500 asserted via PY/TN/KL bands
  const worst = annualTotal(st, 500000);
  ok(`${st} worst-case annual ₹${worst / P} ≤ ₹2,500`, worst <= R(2500));
}

/* ── the silent-gap guard: unmapped state warns, no-PT state stays silent ──── */
{
  const mk = (stateCode) => IN.compute({
    periodGrossMinor: R(50000),
    basicMinor: R(30000),
    components: [],
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0, esiLatchedCovered: false },
    period: { end: '2026-06-30', year: 2026, month: 6 },
    employee: { hasPan: true, gender: 'male' },
    entity: { stateCode, pfApplicable: false, esiApplicable: false },
  });
  const gap = mk('XX');
  ok('unmapped state raises PT_STATE_UNMAPPED WARN', (gap.anomalies || []).some((a) => a.code === 'PT_STATE_UNMAPPED'));
  const dl = mk('DL');
  ok('no-PT state (DL) stays silent', !(dl.anomalies || []).some((a) => a.code === 'PT_STATE_UNMAPPED'));
  const cg = mk('CG');
  ok('configured state (CG) has no gap warning', !(cg.anomalies || []).some((a) => a.code === 'PT_STATE_UNMAPPED'));
}

console.log(`ptStates.golden: ${passed} checks passed`);
