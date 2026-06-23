'use strict';

/**
 * deriveBreakup.test.js — PURE golden test for the CTC reverse-derivation lib.
 *
 * Plain-node (built-in assert, NO jest, NO DB):
 *   node src/hr/compensation/__tests__/deriveBreakup.test.js
 *
 * Proves (docs/05 §7 QA 1,2,4,5):
 *   1. CTC derivation + balancing: Σ earnings == targetGross to the paise; the
 *      BALANCING special-allowance is the exact residual.
 *   2. Employer-cost fixed point (IN): CTC == gross + employerCost; converges.
 *   4. India 50% floor: a Basic<50% structure → wagesVerdict.ok=false fail-closed;
 *      a compliant one → ok=true. Country-gated OFF for NZ.
 *   5. Engine-consumption parity: the derived structure run through
 *      engine.computePayslip reproduces the same gross/earnings to the paise.
 *   + STRUCTURE_INFEASIBLE when fixed+percent already exceed target (no balancing).
 *   + UNSUPPORTED_NET_BASIS rejection.
 */

const assert = require('assert');
const {
  deriveBreakup,
  materializeRevisionLines,
  employerCostFixedPoint,
  DeriveError,
} = require('../deriveBreakup');
const engine = require('../../payroll/engine');
const india = require('../../payroll/compliance/india');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }
function throws(fn, code, msg) {
  try { fn(); failures += 1; log(`  FAIL  ${msg} (no throw)`); }
  catch (e) { if (e.code === code) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg} (got ${e.code || e.message})`); } }
}

const P = 100; // paise per rupee
const R = (rupees) => Math.round(rupees * P);

// Canonical IN CTC structure: Basic=50% CTC, HRA=50% Basic, Conveyance flat,
// Special = balancing.
function inStructure() {
  return [
    { component: { id: 'c-basic', code: 'BASIC', kind: 'BASIC', category: 'EARNING', calcMethod: 'PERCENT_OF', calcBaseScope: 'CTC', isWageForPF: true, derivationPass: 2 }, calcMethod: 'PERCENT_OF', calcValue: '50', sortOrder: 0 },
    { component: { id: 'c-hra', code: 'HRA', kind: 'HRA', category: 'EARNING', calcMethod: 'PERCENT_OF', calcBaseCode: 'BASIC', derivationPass: 1 }, calcMethod: 'PERCENT_OF', calcValue: '50', sortOrder: 1 },
    { component: { id: 'c-conv', code: 'CONV', kind: 'CONVEYANCE', category: 'EARNING', calcMethod: 'FLAT', derivationPass: 0 }, calcMethod: 'FLAT', calcValue: '1600', sortOrder: 2 },
    { component: { id: 'c-spl', code: 'SPECIAL', kind: 'SPECIAL_ALLOWANCE', category: 'EARNING', calcMethod: 'BALANCING', derivationPass: 3 }, calcMethod: 'BALANCING', sortOrder: 3 },
  ];
}

function main() {
  log('\n=== deriveBreakup — pure CTC reverse-derivation golden ===\n');

  // ── QA1+2: CTC 12,00,000 IN, balancing reconciles, employer-cost fixed point ──
  const ctcAnnualMinor = R(1200000); // ₹12,00,000
  const d = deriveBreakup({ target: { ctcAnnualMinor }, basis: 'CTC', lines: inStructure(), ctx: { countryCode: 'IN', asOf: '2026-06-01' } });

  const ctcMonthly = R(100000);
  ok(d.targetGrossMinor + d.employerCost.monthlyMinor === ctcMonthly, 'QA2 CTC monthly == gross + employerCost (fixed point closes)');
  ok(d.grossMinor === d.targetGrossMinor, 'QA1 Σ earnings == targetGross to the paise');

  const byCode = Object.fromEntries(d.resolved.map((r) => [r.code, r.amountMonthlyMinor]));
  ok(byCode.BASIC === R(50000), 'BASIC = 50% of CTC monthly = ₹50,000');
  ok(byCode.HRA === R(25000), 'HRA = 50% of BASIC = ₹25,000');
  ok(byCode.CONV === R(1600), 'CONV flat = ₹1,600');
  const expectedSpecial = d.targetGrossMinor - (byCode.BASIC + byCode.HRA + byCode.CONV);
  ok(byCode.SPECIAL === expectedSpecial, `SPECIAL = balancing residual = ₹${(expectedSpecial / 100).toFixed(2)}`);
  ok(d.employerCost.monthlyMinor > 0, 'employer cost quoted > 0');

  // ── QA4: India 50% floor — compliant structure passes ──
  ok(d.wagesVerdict.applies === true && d.wagesVerdict.ok === true, 'QA4 compliant IN structure → wagesVerdict.ok=true');

  // ── QA4: a Basic-light structure FAILS fail-closed ──
  const badLines = [
    { component: { id: 'c-basic', code: 'BASIC', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT', derivationPass: 0 }, calcMethod: 'FLAT', calcValue: '10000', sortOrder: 0 },
    { component: { id: 'c-spl', code: 'SPECIAL', kind: 'SPECIAL_ALLOWANCE', category: 'EARNING', calcMethod: 'BALANCING', derivationPass: 3 }, calcMethod: 'BALANCING', sortOrder: 1 },
  ];
  const bad = deriveBreakup({ target: { grossMonthlyMinor: R(50000) }, basis: 'GROSS', lines: badLines, ctx: { countryCode: 'IN', asOf: '2026-06-01' } });
  ok(bad.wagesVerdict.ok === false && bad.wagesVerdict.code === 'WAGES_50_RULE', 'QA4 Basic ₹10k of ₹50k gross → fail-closed WAGES_50_RULE');

  // ── QA4 country-gate: NZ skips the 50% rule ──
  const nzLines = [
    { component: { id: 'n-sal', code: 'SALARY', kind: 'BASIC', category: 'EARNING', calcMethod: 'BALANCING', derivationPass: 3 }, calcMethod: 'BALANCING', sortOrder: 0 },
  ];
  const nz = deriveBreakup({ target: { grossMonthlyMinor: R(7500) }, basis: 'GROSS', lines: nzLines, ctx: { countryCode: 'NZ', asOf: '2026-06-01' } });
  ok(nz.wagesVerdict.applies === false, 'QA4 NZ gross-basis → 50% rule NOT applied (country-gated)');
  ok(nz.grossMinor === R(7500), 'NZ balancing fills to gross target exactly');

  // ── STRUCTURE_INFEASIBLE: fixed earnings exceed target, no balancing ──
  const infeasible = [
    { component: { id: 'x1', code: 'A', kind: 'SPECIAL_ALLOWANCE', category: 'EARNING', calcMethod: 'FLAT', derivationPass: 0 }, calcMethod: 'FLAT', calcValue: '60000', sortOrder: 0 },
  ];
  throws(
    () => deriveBreakup({ target: { grossMonthlyMinor: R(50000) }, basis: 'GROSS', lines: infeasible, ctx: { countryCode: 'IN', asOf: '2026-06-01' } }),
    'STRUCTURE_INFEASIBLE',
    'fixed earnings > target gross with no balancing → STRUCTURE_INFEASIBLE',
  );

  // ── UNSUPPORTED_NET_BASIS ──
  throws(
    () => deriveBreakup({ target: {}, basis: 'NET', lines: [], ctx: {} }),
    'UNSUPPORTED_NET_BASIS',
    'basis=NET → UNSUPPORTED_NET_BASIS (deferred in v1)',
  );

  // ── QA5: engine-consumption parity (the golden contract) ──
  const ecomps = d.resolved.map((x, i) => {
    const base = {
      code: x.code, name: x.code, category: 'EARNING', prorationPolicy: 'CALENDAR_DAYS',
      lopBehavior: 'REDUCES_WITH_LOP', _order: i, isBasic: x.code === 'BASIC', isPfWages: x.code === 'BASIC',
    };
    if (x.isBalancing) return { ...base, calcMethod: 'BALANCING', targetGrossMinor: d.targetGrossMinor };
    return { ...base, calcMethod: 'FIXED', amountMinor: x.amountMonthlyMinor };
  });
  const ps = engine.computePayslip({
    components: ecomps,
    inputs: { payableDays: 30, standardDays: 30, lopDays: 0 },
    complianceModule: india,
    period: { start: '2026-06-01', end: '2026-06-30', payDate: '2026-06-30' },
    employee: {}, entity: { countryCode: 'IN', pfApplicable: true }, currencyCode: 'INR',
  });
  ok(ps.grossMinor === d.grossMinor, 'QA5 engine gross == derived gross (paise parity)');
  for (const e of ps.earnings) {
    ok(e.amountMinor === byCode[e.code], `QA5 engine ${e.code} == derived (₹${(e.amountMinor / 100).toFixed(2)})`);
  }
  // CTC = derived gross + (statutory employer contributions + gratuity provision).
  const gratuityProvision = d.employerCost.items.find((it) => it.code === 'GRATUITY_PROVISION');
  const erReconcile = ps.totalEmployerContributionsMinor + (gratuityProvision ? gratuityProvision.amountMinor : 0);
  ok(d.targetGrossMinor + erReconcile === ctcMonthly, 'QA5 CTC == gross + engine-ER + gratuity-provision (quote/runtime reconcile)');

  // ── employerCostFixedPoint convergence (≤4 iters, monotone) ──
  const fp = employerCostFixedPoint({
    ctcAnnualMinor: R(1200000),
    resolveBasicDaMonthly: (gross) => Math.round(gross * 0.5),
  });
  ok(fp.employerCostMonthlyMinor > 0 && fp.basicDaMonthlyMinor > 0, 'fixed point returns non-zero employer cost + Basic+DA');

  // ── materializeRevisionLines emits Prisma create rows with concrete amounts ──
  const m = materializeRevisionLines({ lines: inStructure(), basis: 'CTC' }, { target: { ctcAnnualMinor }, countryCode: 'IN', asOf: '2026-06-01' });
  ok(m.lines.length === 4, 'materializeRevisionLines emits one create row per line');
  ok(m.lines.every((l) => l.amountMonthly != null && l.componentId), 'every materialized line carries amountMonthly + componentId');
  const matBalancing = m.lines.find((l) => l.calcMethod === 'BALANCING');
  ok(matBalancing && Number(matBalancing.amountMonthly) > 0, 'materialized BALANCING line has a concrete amount');

  // ── Finding 1: PERCENT-defined structure RESOLVES (no amountMonthly literals) ──
  // The canonical inStructure() carries ONLY percent calcValues + a flat + a
  // balancing — NO amountMonthly. Materializing it must produce concrete amounts
  // and a wagesVerdict computed on the DERIVED (not literal-percent) gross.
  log('\n— percent-defined structure resolution + 50% floor on derived amounts —');
  {
    const percentOnly = inStructure().map((l) => ({ ...l, amountMonthly: undefined }));
    ok(percentOnly.every((l) => l.amountMonthly == null), 'fixture lines carry NO amountMonthly (percent-defined)');
    const mp = materializeRevisionLines({ lines: percentOnly, basis: 'CTC' }, { target: { ctcAnnualMinor }, basis: 'CTC', countryCode: 'IN', asOf: '2026-06-01' });
    const basicLine = mp.lines.find((l) => l.componentId === 'c-basic');
    ok(basicLine && Math.round(Number(basicLine.amountMonthly) * 100) === R(50000), 'BASIC resolves to ₹50,000 from 50%-of-CTC (NOT ₹50 from the percent literal)');
    ok(mp.breakup.wagesVerdict.applies && mp.breakup.wagesVerdict.ok, 'compliant percent structure → wagesVerdict.ok=true on DERIVED amounts');
  }

  // ── Finding 1: a percent structure that genuinely breaches Basic<50% FAILS ──
  {
    // BASIC=20% of CTC, HRA=10% of BASIC, rest balancing → Basic+DA < 50% gross.
    const breach = [
      { component: { id: 'b-basic', code: 'BASIC', kind: 'BASIC', category: 'EARNING', calcMethod: 'PERCENT_OF', calcBaseScope: 'CTC', isWageForPF: true, derivationPass: 2 }, calcMethod: 'PERCENT_OF', calcValue: '20', sortOrder: 0 },
      { component: { id: 'b-spl', code: 'SPECIAL', kind: 'SPECIAL_ALLOWANCE', category: 'EARNING', calcMethod: 'BALANCING', derivationPass: 3 }, calcMethod: 'BALANCING', sortOrder: 1 },
    ];
    const db = deriveBreakup({ target: { ctcAnnualMinor: R(1200000) }, basis: 'CTC', lines: breach, ctx: { countryCode: 'IN', asOf: '2026-06-01' } });
    ok(db.wagesVerdict.applies && db.wagesVerdict.ok === false && db.wagesVerdict.code === 'WAGES_50_RULE',
      'BASIC=20%-of-CTC percent structure → DERIVED Basic<50% caught fail-closed (would FAIL-OPEN on raw percent literals)');
  }

  // ── Finding 5: a BALANCING line with a floor/cap that bites → STRUCTURE_INFEASIBLE ──
  log('\n— balancing-line clamp is infeasible, never silently clamped —');
  {
    // BASIC flat ₹20,000 of ₹50,000 gross; SPECIAL balancing residual = ₹30,000
    // but capped at ₹5,000 — the cap cannot absorb the residual → infeasible.
    const cappedBal = [
      { component: { id: 'cb-basic', code: 'BASIC', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT', derivationPass: 0 }, calcMethod: 'FLAT', calcValue: '20000', sortOrder: 0 },
      { component: { id: 'cb-spl', code: 'SPECIAL', kind: 'SPECIAL_ALLOWANCE', category: 'EARNING', calcMethod: 'BALANCING', capValue: '5000', derivationPass: 3 }, calcMethod: 'BALANCING', sortOrder: 1 },
    ];
    throws(
      () => deriveBreakup({ target: { grossMonthlyMinor: R(50000) }, basis: 'GROSS', lines: cappedBal, ctx: { countryCode: 'IN', asOf: '2026-06-01' } }),
      'STRUCTURE_INFEASIBLE',
      'BALANCING line capped below its residual → STRUCTURE_INFEASIBLE (no silent clamp, Σ would drift)',
    );
  }
  {
    // A balancing FLOOR above the residual also cannot reconcile → infeasible.
    const flooredBal = [
      { component: { id: 'fb-basic', code: 'BASIC', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT', derivationPass: 0 }, calcMethod: 'FLAT', calcValue: '48000', sortOrder: 0 },
      { component: { id: 'fb-spl', code: 'SPECIAL', kind: 'SPECIAL_ALLOWANCE', category: 'EARNING', calcMethod: 'BALANCING', floorValue: '10000', derivationPass: 3 }, calcMethod: 'BALANCING', sortOrder: 1 },
    ];
    throws(
      () => deriveBreakup({ target: { grossMonthlyMinor: R(50000) }, basis: 'GROSS', lines: flooredBal, ctx: { countryCode: 'IN', asOf: '2026-06-01' } }),
      'STRUCTURE_INFEASIBLE',
      'BALANCING line floored above its residual → STRUCTURE_INFEASIBLE',
    );
  }
  {
    // A balancing line whose floor/cap does NOT bite still reconciles cleanly.
    const okBal = [
      { component: { id: 'ob-basic', code: 'BASIC', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT', derivationPass: 0 }, calcMethod: 'FLAT', calcValue: '30000', sortOrder: 0 },
      { component: { id: 'ob-spl', code: 'SPECIAL', kind: 'SPECIAL_ALLOWANCE', category: 'EARNING', calcMethod: 'BALANCING', floorValue: '1000', capValue: '40000', derivationPass: 3 }, calcMethod: 'BALANCING', sortOrder: 1 },
    ];
    const okd = deriveBreakup({ target: { grossMonthlyMinor: R(50000) }, basis: 'GROSS', lines: okBal, ctx: { countryCode: 'NZ', asOf: '2026-06-01' } });
    ok(okd.grossMinor === R(50000), 'non-biting balancing floor/cap → Σ reconciles to target exactly');
  }

  // ── Finding 7: employerCostFixedPoint asserts convergence (throws on divergence) ──
  log('\n— employer-cost convergence is asserted —');
  {
    // A pathological resolver that oscillates Basic+DA so the loop never settles
    // within 1 paise → must throw EMPLOYER_COST_DIVERGED, not ship a bad split.
    let toggle = 0;
    throws(
      () => employerCostFixedPoint({
        ctcAnnualMinor: R(1200000),
        resolveBasicDaMonthly: () => { toggle = toggle ? 0 : R(80000); return toggle; },
        maxIters: 4,
      }),
      'EMPLOYER_COST_DIVERGED',
      'non-converging employer-cost fixed point → EMPLOYER_COST_DIVERGED (never silently ships off-by-N split)',
    );
  }

  log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} — deriveBreakup\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
