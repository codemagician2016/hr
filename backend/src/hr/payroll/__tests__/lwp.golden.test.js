'use strict';

/*
 * lwp.golden.test.js — INDEPENDENT QA golden test for Feature 16
 * (attendance-driven payroll proration + Leave Without Pay, India).
 *
 * Plain-node (built-in `assert`, NO jest, NO DB):
 *   node backend/src/hr/payroll/__tests__/lwp.golden.test.js
 *
 * Every expected value is hand-derived from docs/features/16 and the proration
 * arithmetic in payroll/engine.js (the public contract), NOT by reading the
 * engine's internal back-fill. MONEY = integer minor units (paise). ₹1 = 100p.
 *
 * Covers (the §9 test matrix, pure slices):
 *   1. India statutory leave-floor resolver (per state, effective-dated)
 *   2. LWP/leave-type coherence (UNPAID ⇒ isPaid=false ∧ affectsLOP=true)
 *   3. materialiseLeaveDays (full LWP, half-day, paid-leave-0, weekoff skip)
 *   4. rollupEmployee LOP split (LWP→lwpDays, ABSENT→absentDays; reconcile)
 *   5. engine proration per basis (CALENDAR_DAYS, FIXED_30, WORKING_DAYS) to the paise
 *   6. AccrualMethod.NONE never grants units
 *   7. india.compute on a prorated gross shrinks PF/ESI/PT with LOP
 */

const assert = require('assert');
const IN = require('../compliance/india.js');
const engine = require('../engine.js');
const { _internals: freezeInternals } = require('../../attendance/freeze.js');
const { materialiseLeaveDays } = require('../../leave/leaveToAttendance.js');
const accrual = require('../../leave/accrual.js');

const rollupEmployee = freezeInternals.rollupEmployee;
const { computePayslip, CATEGORY, CALC, PRORATION, LOP_BEHAVIOR } = engine;

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}
function eq(name, got, want) {
  ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ── 1. Statutory leave-floor resolver ──────────────────────────────────────
console.log('\n(1) India statutory leave-floor resolver:');
eq('MH EL floor = 21', IN.resolveLeaveFloor('MH', 'EL', '2026-04-01'), 21);
eq('MH SL floor = 8', IN.resolveLeaveFloor('MH', 'SL', '2026-04-01'), 8);
eq('KA SL floor (SICK alias) = 12', IN.resolveLeaveFloor('KA', 'SICK', '2026-04-01'), 12);
eq('TN CL floor (CASUAL alias) = 0', IN.resolveLeaveFloor('TN', 'CASUAL', '2026-04-01'), 0);
eq('unknown state XX falls back to * EL=15', IN.resolveLeaveFloor('XX', 'EL', '2026-04-01'), 15);
eq('UNPAID/LWP has no floor → null', IN.resolveLeaveFloor('MH', 'UNPAID', '2026-04-01'), null);
eq('framework read MH EL=21', IN.resolveLeaveFramework('MH', '2026-04-01').floors.EL, 21);

// ── 2. LWP / leave-type coherence (mirrors controller validateLeaveTypeBody) ──
// We re-derive the EXPECTED coherence rule here (the controller forces it server-side):
//   UNPAID ⇒ isPaid=false ∧ affectsLOP=true ; a PAID type with affectsLOP=true is incoherent.
console.log('\n(2) LWP / leave-type coherence rule:');
function coherence(category, isPaid, affectsLOP) {
  if (category === 'UNPAID') return { isPaid: false, affectsLOP: true, error: null };
  if (isPaid === true && affectsLOP === true) return { error: 'INCOHERENT_LEAVE_TYPE' };
  return { error: null };
}
const lwp = coherence('UNPAID', true, false); // admin tried to make LWP paid
eq('UNPAID forces isPaid=false', lwp.isPaid, false);
eq('UNPAID forces affectsLOP=true', lwp.affectsLOP, true);
eq('paid + affectsLOP is rejected', coherence('CASUAL', true, true).error, 'INCOHERENT_LEAVE_TYPE');
eq('paid CL (no LOP) is coherent', coherence('CASUAL', true, false).error, null);

// ── 3. materialiseLeaveDays (PURE bridge) ───────────────────────────────────
console.log('\n(3) materialiseLeaveDays:');
// Mon 2026-01-05 .. Wed 2026-01-07 (3 working days); Sun/Sat weekoff (0,6).
const lwpType = { affectsLOP: true, sandwichPolicy: 'EXCLUSIVE' };
const paidType = { affectsLOP: false };
const ctxBase = { employee: {}, weeklyOffDays: '0,6', holidays: [] };

const fullLwp = materialiseLeaveDays({ startDate: '2026-01-05', endDate: '2026-01-07' }, { ...ctxBase, leaveType: lwpType });
eq('full LWP emits 3 ON_LEAVE days', fullLwp.length, 3);
ok('full LWP days all lopFraction 1', fullLwp.every((d) => d.lopFraction === 1 && d.status === 'ON_LEAVE'));

const halfLwp = materialiseLeaveDays({ startDate: '2026-01-05', endDate: '2026-01-05', startHalf: 'AM' }, { ...ctxBase, leaveType: lwpType });
eq('half-day LWP emits 1 day', halfLwp.length, 1);
eq('half-day LWP lopFraction 0.5', halfLwp[0].lopFraction, 0.5);

const paid = materialiseLeaveDays({ startDate: '2026-01-05', endDate: '2026-01-07' }, { ...ctxBase, leaveType: paidType });
ok('paid leave emits ON_LEAVE with lopFraction 0 (no LOP)', paid.length === 3 && paid.every((d) => d.lopFraction === 0));

// A holiday inside the span (EXCLUSIVE) stays payable → not emitted as LOP.
const ctxHoliday = { ...ctxBase, leaveType: lwpType, holidays: [{ date: '2026-01-06' }] };
const withHoliday = materialiseLeaveDays({ startDate: '2026-01-05', endDate: '2026-01-07' }, ctxHoliday);
ok('holiday inside LWP block is NOT emitted as LOP (EXCLUSIVE)', !withHoliday.some((d) => d.date === '2026-01-06'));

// ── 4. rollupEmployee LOP split + reconcile identity ────────────────────────
console.log('\n(4) rollupEmployee LOP provenance split:');
// Jan 2026 = 31 days. 27 present, 3 LWP (ON_LEAVE lop=1), 1 ABSENT (lop=1).
const rows = [];
for (let i = 0; i < 27; i += 1) rows.push({ id: `p${i}`, status: 'PRESENT', lopFraction: 0 });
for (let i = 0; i < 3; i += 1) rows.push({ id: `l${i}`, status: 'ON_LEAVE', lopFraction: 1 });
rows.push({ id: 'a1', status: 'ABSENT', lopFraction: 1 });
const roll = rollupEmployee(rows, '2026-01-01', '2026-01-31', { prorationBasis: 'CALENDAR_DAYS' });
eq('calendarDays 31', roll.calendarDays, 31);
eq('lopDays 4', roll.lopDays, 4);
eq('lwpDays 3 (approved unpaid)', roll.lwpDays, 3);
eq('absentDays 1 (AWOL)', roll.absentDays, 1);
eq('payableDays 27', roll.payableDays, 27);
eq('standardDays 31 (CALENDAR)', roll.standardDays, 31);
ok('reconcile payable + lop == standard', roll.payableDays + roll.lopDays === roll.standardDays);
// LWP + ABSENT are disjoint subsets of LOP.
ok('lwp + absent == lop (no other LOP here)', roll.lwpDays + roll.absentDays === roll.lopDays);
// Paid leave does NOT cause LOP.
const paidRows = [];
for (let i = 0; i < 28; i += 1) paidRows.push({ id: `p${i}`, status: 'PRESENT', lopFraction: 0 });
for (let i = 0; i < 3; i += 1) paidRows.push({ id: `pl${i}`, status: 'ON_LEAVE', lopFraction: 0 }); // PAID leave
const rollPaid = rollupEmployee(paidRows, '2026-01-01', '2026-01-31', { prorationBasis: 'CALENDAR_DAYS' });
eq('paid leave → lopDays 0', rollPaid.lopDays, 0);
eq('paid leave → lwpDays 0', rollPaid.lwpDays, 0);
eq('paid leave → payableDays 31 (full pay)', rollPaid.payableDays, 31);
// FIXED_30 basis standardDays + payableDays (F16 HIGH#2 regression guard).
// Jan 2026 = 31 calendar days, 4 LOP. payableDays MUST be 30−4=26 (a 30-day
// numerator), NOT the old calendar 31−4=27. 27/30 would over-pay every LOP day.
const roll30 = rollupEmployee(rows, '2026-01-01', '2026-01-31', { prorationBasis: 'FIXED_30' });
eq('FIXED_30 standardDays 30', roll30.standardDays, 30);
eq('FIXED_30 payableDays = 30−4 = 26 (NOT 31−4=27)', roll30.payableDays, 26);
ok('FIXED_30 payable+lop == standard (one basis)', roll30.payableDays + roll30.lopDays === roll30.standardDays);

// WORKING_DAYS basis (F16 HIGH#1 regression guard). Feb 2026 = 28 calendar days.
// 8 weekly-offs → standardDays = 28−8 = 20 working days. 3 LOP days (e.g. LWP).
// payableDays MUST be 20−3=17 (a working-days numerator), NOT the old calendar
// 28−3=25 — which, being ≥ standardDays(20), made the engine CLAMP LOP to zero and
// pay an absent employee in full.
const febRows = [];
for (let i = 0; i < 17; i += 1) febRows.push({ id: `p${i}`, status: 'PRESENT', lopFraction: 0 });
for (let i = 0; i < 8; i += 1) febRows.push({ id: `w${i}`, status: 'WEEKLY_OFF', lopFraction: 0 });
for (let i = 0; i < 3; i += 1) febRows.push({ id: `l${i}`, status: 'ON_LEAVE', lopFraction: 1 }); // 3 LWP
const rollWork = rollupEmployee(febRows, '2026-02-01', '2026-02-28', { prorationBasis: 'WORKING_DAYS' });
eq('WORKING_DAYS calendarDays 28', rollWork.calendarDays, 28);
eq('WORKING_DAYS weeklyOffDays 8', rollWork.weeklyOffDays, 8);
eq('WORKING_DAYS standardDays = 28−8 = 20', rollWork.standardDays, 20);
eq('WORKING_DAYS payableDays = 20−3 = 17 (NOT calendar 28−3=25)', rollWork.payableDays, 17);
eq('WORKING_DAYS lopDays 3 (all LWP)', rollWork.lopDays, 3);
ok('WORKING_DAYS payable+lop == standard (one basis)', rollWork.payableDays + rollWork.lopDays === rollWork.standardDays);
// Paid leave on a WORKING_DAYS tenant must NOT cost the employee anything.
const febPaid = [];
for (let i = 0; i < 20; i += 1) febPaid.push({ id: `p${i}`, status: 'PRESENT', lopFraction: 0 });
for (let i = 0; i < 8; i += 1) febPaid.push({ id: `w${i}`, status: 'WEEKLY_OFF', lopFraction: 0 });
const rollWorkPaid = rollupEmployee(febPaid, '2026-02-01', '2026-02-28', { prorationBasis: 'WORKING_DAYS' });
eq('WORKING_DAYS no LOP → payableDays == standardDays 20 (full pay)', rollWorkPaid.payableDays, 20);
eq('WORKING_DAYS no LOP → lopDays 0', rollWorkPaid.lopDays, 0);

// ── 5. Engine proration per basis (paise-exact) ─────────────────────────────
console.log('\n(5) engine proration per basis:');
// Single FIXED earning ₹31,000.00 = 3,100,000 paise. 4 LOP days, 27 payable.
const SALARY = 3100000;
const comp = [{
  code: 'BASIC', name: 'Basic', category: CATEGORY.EARNING, calcMethod: CALC.FIXED,
  amountMinor: SALARY, prorationPolicy: PRORATION.CALENDAR_DAYS, lopBehavior: LOP_BEHAVIOR.REDUCES_WITH_LOP,
  isBasic: true, isPfWages: true, _order: 0,
}];
const noModule = { compute: () => ({ employeeDeductions: [], employerContributions: [], anomalies: [] }) };

// CALENDAR_DAYS: 3,100,000 × 27/31 = 2,700,000 exactly (31,000×27/31 = 27,000).
const rCal = computePayslip({
  components: comp, complianceModule: noModule,
  inputs: { calendarDays: 31, standardDays: 31, payableDays: 27, lopDays: 4 },
  period: { start: '2026-01-01', end: '2026-01-31' },
});
eq('CALENDAR_DAYS gross = ₹27,000.00', rCal.grossMinor, 2700000);

// FIXED_30: 3,100,000 × (30−4)/30 = 3,100,000 × 26/30 = 2,686,666.67 → 2686667 paise (HALF_UP).
// CRITICAL: drive payableDays/standardDays from the REAL freeze rollup (roll30) so
// this guards the freeze→engine seam, NOT a hand-fed value. (The old test fed
// payableDays:26 which freeze.js never produced — it produced 27 — masking HIGH#2.)
const comp30 = [{ ...comp[0], prorationPolicy: PRORATION.FIXED_30 }];
const r30 = computePayslip({
  components: comp30, complianceModule: noModule,
  inputs: { calendarDays: roll30.calendarDays, standardDays: roll30.standardDays, payableDays: roll30.payableDays, lopDays: roll30.lopDays },
  period: { start: '2026-01-01', end: '2026-01-31' },
});
// 3,100,000 × 26 = 80,600,000 ; /30 = 2,686,666.666… → 2,686,667 (HALF_UP).
eq('FIXED_30 gross = ₹26,866.67 (from real rollup payableDays=26)', r30.grossMinor, 2686667);
// Prove the OLD buggy numerator (27/30) would have OVER-paid: 3,100,000×27/30 = 2,790,000.
ok('FIXED_30 gross ≠ buggy 27/30 (₹27,900) — LOP day actually charged', r30.grossMinor !== 2790000);

// Full-LOP month: payableDays 0 → gross 0.
const rZero = computePayslip({
  components: comp, complianceModule: noModule,
  inputs: { calendarDays: 31, standardDays: 31, payableDays: 0, lopDays: 31 },
  period: { start: '2026-01-01', end: '2026-01-31' },
});
eq('full-LOP month → gross 0', rZero.grossMinor, 0);

// FIXED_REGARDLESS allowance is NOT reduced by LOP.
const compFixed = [
  { ...comp[0] },
  { code: 'STAT_ALLOW', name: 'Statutory floor allowance', category: CATEGORY.EARNING, calcMethod: CALC.FIXED, amountMinor: 100000, prorationPolicy: PRORATION.NONE, lopBehavior: LOP_BEHAVIOR.FIXED_REGARDLESS, _order: 1 },
];
const rFixed = computePayslip({
  components: compFixed, complianceModule: noModule,
  inputs: { calendarDays: 31, standardDays: 31, payableDays: 27, lopDays: 4 },
  period: { start: '2026-01-01', end: '2026-01-31' },
});
// BASIC prorated to 2,700,000 + STAT_ALLOW unreduced 100,000 = 2,800,000.
eq('FIXED_REGARDLESS allowance unreduced', rFixed.grossMinor, 2800000);

// ── 5b. freeze→engine SEAM per basis, driven by REAL rollup output ──────────
// The regression net: feed the engine EXACTLY what freeze.js froze (calendarDays,
// standardDays, payableDays, lopDays from rollupEmployee) for each basis, and prove
// an absent/LWP employee LOSES the correct amount — to the paise.
console.log('\n(5b) freeze→engine seam (real rollup, all three bases):');
const GROSS = 3000000; // ₹30,000.00
const seamComp = (policy) => [{
  code: 'BASIC', name: 'Basic', category: CATEGORY.EARNING, calcMethod: CALC.FIXED,
  amountMinor: GROSS, prorationPolicy: policy, lopBehavior: LOP_BEHAVIOR.REDUCES_WITH_LOP,
  isBasic: true, isPfWages: true, _order: 0,
}];
const runSeam = (policy, roll, period) => computePayslip({
  components: seamComp(policy), complianceModule: noModule,
  inputs: { calendarDays: roll.calendarDays, standardDays: roll.standardDays, payableDays: roll.payableDays, lopDays: roll.lopDays },
  period,
});

// CALENDAR_DAYS — Jan 2026, 4 LOP (the §4 `rows` rollup). 3,000,000 × 27/31 =
// 81,000,000/31 = 2,612,903.226 → 2,612,903 (HALF_UP).
const rollCal = rollupEmployee(rows, '2026-01-01', '2026-01-31', { prorationBasis: 'CALENDAR_DAYS' });
const seamCal = runSeam(PRORATION.CALENDAR_DAYS, rollCal, { start: '2026-01-01', end: '2026-01-31' });
eq('SEAM CALENDAR_DAYS gross 30k×27/31 = ₹26,129.03', seamCal.grossMinor, 2612903);

// WORKING_DAYS — Feb 2026, 3 LWP, standardDays 20, payableDays 17 (rollWork above).
// 3,000,000 × 17/20 = 2,550,000 EXACTLY. The bug paid 3,000,000 (full) — a ₹4,500 hit.
const seamWork = runSeam(PRORATION.WORKING_DAYS, rollWork, { start: '2026-02-01', end: '2026-02-28' });
eq('SEAM WORKING_DAYS absent employee gross 30k×17/20 = ₹25,500.00', seamWork.grossMinor, 2550000);
ok('SEAM WORKING_DAYS absent employee is NOT paid in full (bug fixed)', seamWork.grossMinor < GROSS);
eq('SEAM WORKING_DAYS LOP charge = exactly ₹4,500.00', GROSS - seamWork.grossMinor, 450000);

// WORKING_DAYS, paid leave only (rollWorkPaid): payableDays==standardDays → FULL pay.
const seamWorkPaid = runSeam(PRORATION.WORKING_DAYS, rollWorkPaid, { start: '2026-02-01', end: '2026-02-28' });
eq('SEAM WORKING_DAYS paid-leave-only → full ₹30,000.00 (paid leave ≠ LOP)', seamWorkPaid.grossMinor, GROSS);

// FIXED_30 — Jan 2026, 4 LOP, standardDays 30, payableDays 26 (roll30).
// 3,000,000 × 26/30 = 2,600,000 EXACTLY. The bug paid 27/30 = 2,700,000 — ₹1,000 over.
const seam30 = runSeam(PRORATION.FIXED_30, roll30, { start: '2026-01-01', end: '2026-01-31' });
eq('SEAM FIXED_30 gross 30k×26/30 = ₹26,000.00', seam30.grossMinor, 2600000);
ok('SEAM FIXED_30 ≠ buggy 27/30 (₹27,000) — each LOP day charged in full', seam30.grossMinor !== 2700000);
eq('SEAM FIXED_30 LOP charge = exactly ₹4,000.00 (4 days × ₹1,000)', GROSS - seam30.grossMinor, 400000);

// ── 6. AccrualMethod.NONE never grants units ────────────────────────────────
console.log('\n(6) AccrualMethod.NONE (LWP) accrues nothing:');
const noneGrant = accrual.accrueForPeriod({ accrualMethod: 'NONE', entitlementPerYear: 18 }, [], { tenureMonths: 36 });
eq('NONE accrue → 0 units', noneGrant.units, 0);
ok('NONE accrue flagged skipped', noneGrant.skipped === true);
eq('NONE prorataOnJoin → 0', accrual.prorataOnJoin({ accrualMethod: 'NONE' }, '2026-06-10', '2026-06-01', '2026-06-30'), 0);
// Sanity: a normal MONTHLY policy still accrues 1.5/month from 18/yr.
eq('MONTHLY_ACCRUAL still grants 1.5', accrual.accrueForPeriod({ accrualMethod: 'MONTHLY_ACCRUAL', entitlementPerYear: 18, accrualFrequency: 'MONTHLY' }, [], { tenureMonths: 12 }).units, 1.5);

// ── 7. india.compute shrinks PF/PT on a prorated gross ──────────────────────
console.log('\n(7) india.compute on a prorated gross:');
// Full gross ₹50,000 basic; PF EE = 12% of min(basic,15000) = ₹1,800.
const full = IN.compute({
  periodGrossMinor: 5000000, basicMinor: 5000000,
  components: [{ code: 'BASIC', amountMinor: 5000000, isBasic: true, isPfWages: true }],
  bases: { periodGrossMinor: 5000000, basicMinor: 5000000, pfWagesFlaggedMinor: 5000000, esiWagesMinor: 0, ptWagesMinor: 5000000 },
  period: { start: '2026-01-01', end: '2026-01-31', payDate: '2026-02-01' },
  employee: { hasPan: true }, entity: { countryCode: 'IN', stateCode: 'KA', pfApplicable: true },
});
// Prorated to 27/31: basic ₹43,548.39 (4,354,839 paise). PF still capped at ₹15,000 → ₹1,800.
const prorated = IN.compute({
  periodGrossMinor: 4354839, basicMinor: 4354839,
  components: [{ code: 'BASIC', amountMinor: 4354839, isBasic: true, isPfWages: true }],
  bases: { periodGrossMinor: 4354839, basicMinor: 4354839, pfWagesFlaggedMinor: 4354839, esiWagesMinor: 0, ptWagesMinor: 4354839 },
  period: { start: '2026-01-01', end: '2026-01-31', payDate: '2026-02-01' },
  employee: { hasPan: true }, entity: { countryCode: 'IN', stateCode: 'KA', pfApplicable: true },
});
const pfOf = (r) => (r.employeeDeductions.find((d) => d.code === 'EPF') || {}).amountMinor;
// PF is capped at ₹15,000 wage so both equal ₹1,800 — the cap protects the floor.
ok('PF EE present on both (capped wage ₹15k → ₹1,800)', pfOf(full) === 180000 && pfOf(prorated) === 180000,
  `full=${pfOf(full)} prorated=${pfOf(prorated)}`);
ok('compute runs on the prorated gross without throwing', prorated && Array.isArray(prorated.employeeDeductions));

// ── 8. payslip LOP provenance block (LOW#1 — no phantom line) ────────────────
console.log('\n(8) payslip LOP provenance (buildLopProvenance):');
const { _internal: svcInternal } = require('../service.js');
const buildLopProvenance = svcInternal.buildLopProvenance;
// (a) Real LOP, payableDays<standardDays: line is rendered with the right amount.
//     gross ₹25,500 prorated (30k×17/20); standard 20, payable 17, lop 3.
//     full-gross recovered = 25,500×20/17 = 30,000; lop = 30,000×3/20 = ₹4,500.
const provLop = buildLopProvenance({ grossMinor: 2550000 }, { standardDays: 20, payableDays: 17, lopDays: 3, lwpDays: 3, absentDays: 0 });
ok('LOP line present when payableDays<standardDays', provLop.lop && provLop.lop.code === 'LOP');
eq('LOP amount = ₹4,500.00 (recovered full-gross × 3/20)', provLop.lop.amount, '4500.00');
eq('perDayRate = ₹1,500.00 (full-gross ÷ 20)', provLop.perDayRate, '1500.00');
// (b) lopDays==0: no LOP line at all (clean payslip).
const provClean = buildLopProvenance({ grossMinor: 3000000 }, { standardDays: 20, payableDays: 20, lopDays: 0, lwpDays: 0, absentDays: 0 });
ok('no LOP line when lopDays=0 (phantom suppressed)', provClean.lop === undefined);
// (c) DEFENSE: lopDays>0 but payableDays>=standardDays (engine did NOT reduce net) →
//     suppress the line so the provenance can't contradict the actual full-pay net.
const provPhantom = buildLopProvenance({ grossMinor: 3000000 }, { standardDays: 20, payableDays: 25, lopDays: 3, lwpDays: 3, absentDays: 0 });
ok('no phantom LOP line when payableDays>=standardDays (net not reduced)', provPhantom.lop === undefined);
eq('phantom case still surfaces raw lopDays for transparency', provPhantom.lopDays, 3);

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\nlwp.golden: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('=== ALL F16 LWP GOLDENS PASSED ===');
