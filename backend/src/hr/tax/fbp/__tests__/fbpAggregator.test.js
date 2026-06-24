'use strict';

/**
 * fbpAggregator.test.js — Feature 25 PURE (DB-free) tests for the FBP engine:
 * computeFbpSplit (cap clamps, over/under-allocation, residual) + computeFbpExempt
 * (declared vs verified, meal-card always-verified floor, NEW→0, per-head
 * min(alloc,cap,Σverified)) + materializeFbpLines (Σ === envelope to the paise).
 *
 *   node src/hr/tax/fbp/__tests__/fbpAggregator.test.js
 */

const assert = require('assert');
const { computeFbpSplit, computeFbpExempt } = require('../fbpAggregator');
const { materializeFbpLines } = require('../../../compensation/materializeFbpLines');

let pass = 0;
let fail = 0;
function ok(cond, msg) { if (cond) { pass += 1; } else { fail += 1; console.log('  FAIL:', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${a}, want ${b})`); }

// Spec §9 worked case: envelope ₹3,00,000; LTA ₹60k / meal ₹26.4k / fuel ₹21.6k / phone ₹24k.
const heads = [
  { id: 'h-lta', headType: 'LTA', label: 'LTA', taxSection: '10(5)', claimType: 'FBP_LTA', annualCapMinor: null, monthlyCapMinor: null, proofRequired: true, payCadence: 'ON_CLAIM' },
  { id: 'h-meal', headType: 'MEAL_CARD', label: 'Meal', taxSection: '3(7)(iii)', claimType: null, annualCapMinor: 2640000, monthlyCapMinor: 220000, proofRequired: false, payCadence: 'MONTHLY' },
  { id: 'h-fuel', headType: 'FUEL_CAR', label: 'Fuel', taxSection: '3(2)', claimType: 'FBP_FUEL', annualCapMinor: null, monthlyCapMinor: 270000, proofRequired: true, payCadence: 'MONTHLY' },
  { id: 'h-phone', headType: 'TELEPHONE_INTERNET', label: 'Phone', taxSection: '3(7)(ix)', claimType: 'FBP_TELEPHONE', annualCapMinor: null, monthlyCapMinor: null, proofRequired: true, payCadence: 'MONTHLY' },
];
const envelopeMinor = 30000000; // ₹3,00,000
const allocation = [
  { headId: 'h-lta', annualAmountMinor: 6000000 },
  { headId: 'h-meal', annualAmountMinor: 2640000 },
  { headId: 'h-fuel', annualAmountMinor: 2160000 },
  { headId: 'h-phone', annualAmountMinor: 2400000 },
];

// ── computeFbpSplit ──
(() => {
  const s = computeFbpSplit({ envelopeMinor, heads, allocation });
  eq(s.allocatedTotalMinor, 13200000, 'split total allocation = ₹1,32,000');
  eq(s.unallocatedMinor, 16800000, 'split unallocated = ₹1,68,000');
  ok(!s.overAllocated, 'split not over-allocated');
  const meal = s.lines.find((l) => l.headId === 'h-meal');
  eq(meal.exemptCeilingMinor, 2640000, 'meal exempt ceiling clamped at cap');
  eq(meal.overCapMinor, 0, 'meal not over cap');
})();

// ── per-head cap bites (edge case 3): ₹40k to meal vs ₹26.4k cap ──
(() => {
  const s = computeFbpSplit({ envelopeMinor, heads, allocation: [{ headId: 'h-meal', annualAmountMinor: 4000000 }] });
  const meal = s.lines.find((l) => l.headId === 'h-meal');
  eq(meal.exemptCeilingMinor, 2640000, 'meal exempt clamped to ₹26,400');
  eq(meal.overCapMinor, 1360000, '₹13,600 over cap (taxable)');
})();

// ── over-allocation guard (edge case 2) ──
(() => {
  const s = computeFbpSplit({ envelopeMinor: 1000000, heads, allocation: [{ headId: 'h-phone', annualAmountMinor: 2400000 }] });
  ok(s.overAllocated, 'over-allocation flagged when Σ > envelope');
  ok(s.unallocatedMinor < 0, 'unallocated goes negative when over-allocated');
})();

// ── computeFbpExempt OLD pre-deadline (DECLARED) ──
(() => {
  const e = computeFbpExempt({ heads, allocation, proofs: [], window: null, asOf: '2026-06-01', regime: 'OLD' });
  eq(e.totalExemptMinor, 13200000, 'OLD declared exempt = Σ allocation (all under cap)');
  eq(e.basis, 'DECLARED', 'no window → DECLARED basis (fail-open-provisional)');
})();

// ── NEW regime → 0 (edge case 1) ──
(() => {
  const e = computeFbpExempt({ heads, allocation, proofs: [], window: null, asOf: '2026-06-01', regime: 'NEW' });
  eq(e.totalExemptMinor, 0, 'NEW regime exempt = 0 (basket pays but is taxable)');
})();

// ── post-deadline VERIFIED: only ₹40k LTA verified; meal always-verified ──
(() => {
  const window = { proofDeadline: '2027-02-15' };
  const proofs = [{ claimType: 'FBP_LTA', status: 'ACCEPTED', verifiedAmount: 40000, deletedAt: null }];
  const e = computeFbpExempt({ heads, allocation, proofs, window, asOf: '2027-03-01', regime: 'OLD' });
  eq(e.basis, 'VERIFIED', 'on/after deadline → VERIFIED basis');
  const lta = e.lines.find((l) => l.headType === 'LTA');
  eq(lta.exemptMinor, 4000000, 'LTA exempt = ₹40,000 verified (min of alloc/cap/verified)');
  const meal = e.lines.find((l) => l.headType === 'MEAL_CARD');
  eq(meal.exemptMinor, 2640000, 'meal always-verified (the card is the control)');
  const fuel = e.lines.find((l) => l.headType === 'FUEL_CAR');
  eq(fuel.exemptMinor, 0, 'fuel unverified → ₹0 (the §201 control)');
  eq(e.totalExemptMinor, 4000000 + 2640000, 'total verified exempt = ₹66,400');
  // unverified surfaced loudly
  ok(lta.unverifiedMinor === 2000000, 'LTA unverified delta = ₹20,000');
})();

// ── verified can never exceed allocation or cap (edge case 8) ──
(() => {
  const window = { proofDeadline: '2027-02-15' };
  const proofs = [{ claimType: 'FBP_FUEL', status: 'ACCEPTED', verifiedAmount: 999999, deletedAt: null }]; // huge bill
  const e = computeFbpExempt({ heads, allocation, proofs, window, asOf: '2027-03-01', regime: 'OLD' });
  const fuel = e.lines.find((l) => l.headType === 'FUEL_CAR');
  // fuel alloc ₹21,600; monthly cap ₹2,700×12=₹32,400 → declared ceiling = min(21600,32400)=21600
  eq(fuel.exemptMinor, 2160000, 'fuel verified capped at allocation (₹21,600), not the inflated bill');
})();

// ── PENDING/REJECTED proofs contribute 0 ──
(() => {
  const window = { proofDeadline: '2027-02-15' };
  const proofs = [
    { claimType: 'FBP_LTA', status: 'PENDING', verifiedAmount: null, deletedAt: null },
    { claimType: 'FBP_LTA', status: 'REJECTED', verifiedAmount: 50000, deletedAt: null },
  ];
  const e = computeFbpExempt({ heads, allocation, proofs, window, asOf: '2027-03-01', regime: 'OLD' });
  const lta = e.lines.find((l) => l.headType === 'LTA');
  eq(lta.exemptMinor, 0, 'PENDING/REJECTED proofs contribute 0 to verified');
})();

// ── materializeFbpLines Σ-parity (edge case 14: gross before == after) ──
(() => {
  const mat = materializeFbpLines({
    envelopeMonthlyMinor: 2500000, // ₹25,000/mo (₹3,00,000/12)
    heads: heads.map((h) => ({ id: h.id, componentId: `comp-${h.id}`, headType: h.headType, isTaxable: true, taxSection: h.taxSection, category: 'EARNING', payCadence: h.payCadence, sortOrder: 0 })),
    allocation,
    envelopeComponent: { id: 'comp-env', category: 'EARNING', isTaxable: true },
  });
  eq(mat.sumMonthlyMinor + mat.onClaimMonthlyMinor, 2500000, 'Σ(monthly heads + residual) + onClaim === envelope monthly');
  ok(!mat.lines.find((l) => l.headType === 'LTA'), 'LTA (ON_CLAIM) emits no monthly line');
  ok(mat.lines.find((l) => l.isResidual), 'residual line present (under-allocated)');
  ok(mat.onClaimMonthlyMinor === Math.floor(6000000 / 12), 'LTA carved out at ₹5,000/mo (paid on claim)');
})();

// ── materialize clamp: over-allocation clamps to the pool, Σ stays exact (edge case 11) ──
(() => {
  const mat = materializeFbpLines({
    envelopeMonthlyMinor: 500000, // ₹5,000/mo — smaller than the Σ monthly allocation
    heads: heads.filter((h) => h.payCadence === 'MONTHLY').map((h) => ({ id: h.id, componentId: `comp-${h.id}`, headType: h.headType, isTaxable: true, category: 'EARNING', payCadence: 'MONTHLY', sortOrder: 0 })),
    allocation: [{ headId: 'h-fuel', annualAmountMinor: 2160000 }, { headId: 'h-phone', annualAmountMinor: 2400000 }],
    envelopeComponent: { id: 'comp-env', category: 'EARNING', isTaxable: true },
  });
  eq(mat.sumMonthlyMinor, 500000, 'clamped Σ(monthly lines) === shrunk envelope (₹5,000), exact to paise');
})();

console.log(`\nFeature 25 fbpAggregator test: ${pass} passed, ${fail} failed.`);
assert.strictEqual(fail, 0, 'fbpAggregator pure tests must all pass');
