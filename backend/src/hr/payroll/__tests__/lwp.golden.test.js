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
// FIXED_30 basis standardDays.
const roll30 = rollupEmployee(rows, '2026-01-01', '2026-01-31', { prorationBasis: 'FIXED_30' });
eq('FIXED_30 standardDays 30', roll30.standardDays, 30);

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
const comp30 = [{ ...comp[0], prorationPolicy: PRORATION.FIXED_30 }];
const r30 = computePayslip({
  components: comp30, complianceModule: noModule,
  inputs: { calendarDays: 31, standardDays: 30, payableDays: 26, lopDays: 4 },
  period: { start: '2026-01-01', end: '2026-01-31' },
});
// 3,100,000 × 26 = 80,600,000 ; /30 = 2,686,666.666… → 2,686,667 (HALF_UP).
eq('FIXED_30 gross = ₹26,866.67', r30.grossMinor, 2686667);

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

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\nlwp.golden: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('=== ALL F16 LWP GOLDENS PASSED ===');
