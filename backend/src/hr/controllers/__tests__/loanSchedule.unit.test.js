'use strict';

/*
 * loanSchedule.unit.test.js — Loan EMI schedule math (Phase 4 interest methods).
 * Plain-node, NO DB:
 *   node backend/src/hr/controllers/__tests__/loanSchedule.unit.test.js
 *
 * Covers the pure computeSchedule({ principalMinor, annualRatePct, tenureMonths,
 * method }) builder:
 *   - FLAT / SIMPLE — byte-for-byte the historical simple-interest math
 *     (regression-critical) against hand-computed goldens (clean + both remainder
 *     kinds), and SIMPLE proven identical to FLAT.
 *   - ZERO — zero interest regardless of rate, equal-principal.
 *   - REDUCING_BALANCE — amortised EMI: interest strictly decreases, Σprincipal ==
 *     principal, outstanding ends at 0, and a known amortization example
 *     (100000 @ 12% / 12mo) matches the hand-computed EMI (₹8,884.88).
 */

const assert = require('assert');
const { _computeSchedule: computeSchedule } = require('../loans.controller');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

// Sum a component column (2dp strings) back to integer paise.
function sumPaise(rows, key) {
  return rows.reduce((n, r) => n + Math.round(Number(r[key]) * 100), 0);
}

function main() {
  /* ── FLAT golden #1 — clean split, no remainder (12000 @ 10% / 12mo) ── */
  {
    const { rows, totalPayableC } = computeSchedule({
      principalMinor: 1200000, annualRatePct: 10, tenureMonths: 12, method: 'FLAT',
    });
    ok('flat clean: 12 rows', rows.length === 12);
    ok('flat clean: every principal = 1000.00', rows.every((r) => r.principalComponent === '1000.00'));
    ok('flat clean: every interest = 100.00', rows.every((r) => r.interestComponent === '100.00'));
    ok('flat clean: every amount = 1100.00', rows.every((r) => r.amount === '1100.00'));
    ok('flat clean: totalPayableC = 1320000', totalPayableC === 1320000);
    ok('flat clean: Σprincipal == principal', sumPaise(rows, 'principalComponent') === 1200000);
  }

  /* ── FLAT golden #2 — PRINCIPAL remainder into final row (10000 @ 12% / 7mo) ── */
  {
    const { rows, totalPayableC } = computeSchedule({
      principalMinor: 1000000, annualRatePct: 12, tenureMonths: 7, method: 'FLAT',
    });
    // basePrin=142857 (₹1428.57) x6, final row absorbs +1 paise → 142858 (₹1428.58).
    ok('flat prem: rows 1-6 principal = 1428.57', rows.slice(0, 6).every((r) => r.principalComponent === '1428.57'));
    ok('flat prem: final principal = 1428.58', rows[6].principalComponent === '1428.58');
    ok('flat prem: every interest = 100.00', rows.every((r) => r.interestComponent === '100.00'));
    ok('flat prem: final amount = 1528.58', rows[6].amount === '1528.58');
    ok('flat prem: Σprincipal == principal', sumPaise(rows, 'principalComponent') === 1000000);
    ok('flat prem: Σinterest == 70000', sumPaise(rows, 'interestComponent') === 70000);
    ok('flat prem: totalPayableC = 1070000', totalPayableC === 1070000);
  }

  /* ── FLAT golden #3 — INTEREST remainder into final row (10000 @ 10% / 3mo) ── */
  {
    const { rows } = computeSchedule({
      principalMinor: 1000000, annualRatePct: 10, tenureMonths: 3, method: 'FLAT',
    });
    // totalInterest=25000; baseInt=8333 (₹83.33) x2, final absorbs +1 → 8334 (₹83.34).
    ok('flat irem: rows 1-2 interest = 83.33', rows.slice(0, 2).every((r) => r.interestComponent === '83.33'));
    ok('flat irem: final interest = 83.34', rows[2].interestComponent === '83.34');
    ok('flat irem: final principal = 3333.34', rows[2].principalComponent === '3333.34');
    ok('flat irem: Σinterest == 25000', sumPaise(rows, 'interestComponent') === 25000);
    ok('flat irem: Σprincipal == principal', sumPaise(rows, 'principalComponent') === 1000000);
  }

  /* ── SIMPLE == FLAT (alias) ── */
  {
    const flat = computeSchedule({ principalMinor: 1000000, annualRatePct: 12, tenureMonths: 7, method: 'FLAT' });
    const simple = computeSchedule({ principalMinor: 1000000, annualRatePct: 12, tenureMonths: 7, method: 'SIMPLE' });
    ok('SIMPLE identical to FLAT', JSON.stringify(simple) === JSON.stringify(flat));
  }

  /* ── ZERO — no interest regardless of rate, equal-principal ── */
  {
    const { rows, totalPayableC } = computeSchedule({
      principalMinor: 1200000, annualRatePct: 10, tenureMonths: 12, method: 'ZERO',
    });
    ok('zero: interest is 0 despite a 10% rate', rows.every((r) => r.interestComponent === '0.00'));
    ok('zero: every amount == principal portion', rows.every((r) => r.amount === r.principalComponent));
    ok('zero: Σprincipal == principal', sumPaise(rows, 'principalComponent') === 1200000);
    ok('zero: totalPayableC == principal', totalPayableC === 1200000);
    // ZERO must equal a FLAT loan with no rate (both interest-free, equal-principal).
    const flatNoRate = computeSchedule({ principalMinor: 1200000, annualRatePct: null, tenureMonths: 12, method: 'FLAT' });
    ok('zero == flat-with-no-rate', JSON.stringify(rows) === JSON.stringify(flatNoRate.rows));
  }

  /* ── REDUCING_BALANCE — 100000 @ 12% / 12mo (textbook amortization) ── */
  {
    const P = 10000000; // ₹100,000 in paise
    const { rows, totalPayableC } = computeSchedule({
      principalMinor: P, annualRatePct: 12, tenureMonths: 12, method: 'REDUCING_BALANCE',
    });
    ok('reducing: 12 rows', rows.length === 12);

    // Interest STRICTLY decreases period over period (outstanding shrinks).
    const intPaise = rows.map((r) => Math.round(Number(r.interestComponent) * 100));
    let strictlyDown = true;
    for (let k = 1; k < intPaise.length; k += 1) if (!(intPaise[k] < intPaise[k - 1])) strictlyDown = false;
    ok('reducing: interest strictly decreases', strictlyDown);
    ok('reducing: first-period interest = round(P·r) = 1000.00', rows[0].interestComponent === '1000.00');

    // EMI matches the hand-computed value ₹8,884.88 (non-final amount == level EMI).
    ok('reducing: EMI ≈ 8884.88 (row 1 amount)', rows[0].amount === '8884.88');
    const emiPaise = Math.round(Number(rows[0].amount) * 100);
    ok('reducing: EMI within a rupee of hand value', Math.abs(emiPaise - 888488) <= 100);

    // Σprincipal == P exactly and the balance closes at 0 (final row absorbs drift).
    ok('reducing: Σprincipal == principal', sumPaise(rows, 'principalComponent') === P);
    let outstanding = P;
    for (const r of rows) outstanding -= Math.round(Number(r.principalComponent) * 100);
    ok('reducing: outstanding ends at 0', outstanding === 0);

    // totalPayable = P + Σinterest, and each amount = principal + interest.
    ok('reducing: totalPayableC == P + Σinterest', totalPayableC === P + sumPaise(rows, 'interestComponent'));
    ok('reducing: amount == principal + interest per row',
      rows.every((r) => Math.round(Number(r.amount) * 100)
        === Math.round(Number(r.principalComponent) * 100) + Math.round(Number(r.interestComponent) * 100)));
    ok('reducing: interest is cheaper than a 12% flat loan',
      sumPaise(rows, 'interestComponent') < 1200000); // flat 12%/1yr would be ₹12,000
  }

  /* ── REDUCING with a zero rate degenerates to equal-principal (no interest) ── */
  {
    const { rows } = computeSchedule({
      principalMinor: 1200000, annualRatePct: 0, tenureMonths: 12, method: 'REDUCING_BALANCE',
    });
    ok('reducing @0%: interest all 0', rows.every((r) => r.interestComponent === '0.00'));
    ok('reducing @0%: Σprincipal == principal', sumPaise(rows, 'principalComponent') === 1200000);
  }

  console.log(`loanSchedule.unit: ${passed} checks passed`);
}

main();
