'use strict';

/**
 * fbpPlan.test.js — Feature 25 PURE (DB-free) tests for validatePlan. Focus: the
 * proof-free head rules that keep the FBP exemption substantiated —
 *   FBP-2 FIX: every proof-free (exempt-without-bills) head MUST carry a finite
 *     statutory cap (else it is an uncapped, fully-exempt allowance — the ₹2,200/mo
 *     meal cap is droppable by omission); AND only MEAL_CARD may be proof-free (the
 *     card is its own control — defence-in-depth for the FBP-1 engine gate).
 *
 *   node src/hr/compensation/__tests__/fbpPlan.test.js
 */

const assert = require('assert');
const { validatePlan } = require('../fbpPlan');

let pass = 0;
let fail = 0;
function ok(cond, msg) { if (cond) { pass += 1; } else { fail += 1; console.log('  FAIL:', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${a}, want ${b})`); }

const ENV = 'comp-envelope';

// A valid baseline plan: one envelope + a properly-capped MEAL_CARD + a proof-required
// FUEL_CAR (self-capping by its verified bills).
function basePlan(overrides = {}) {
  return {
    envelopeComponentId: ENV,
    heads: [
      { headType: 'MEAL_CARD', componentId: 'comp-meal', annualCapRupees: 26400, monthlyCapRupees: 2200, proofRequired: false, claimType: null },
      { headType: 'FUEL_CAR', componentId: 'comp-fuel', monthlyCapRupees: 2700, proofRequired: true, claimType: 'FBP_FUEL' },
    ],
    ...overrides,
  };
}

// ── baseline is valid ──
(() => {
  const v = validatePlan(basePlan());
  ok(v.ok === true, 'baseline plan (capped meal + proof-required fuel) is valid');
})();

// ── FBP-2 FIX: a proof-free head with NO cap is rejected ──
(() => {
  const v = validatePlan(basePlan({
    heads: [
      { headType: 'MEAL_CARD', componentId: 'comp-meal', proofRequired: false, claimType: null }, // no cap
    ],
  }));
  ok(v.ok === false, 'FBP-2: uncapped proof-free MEAL_CARD is REJECTED (no unbounded tax-free)');
  eq(v.code, 'FBP_PROOFFREE_NO_CAP', 'FBP-2: rejection code is FBP_PROOFFREE_NO_CAP');
})();

// ── FBP-2: a proof-free head with a monthly-only cap is fine (the cap is finite) ──
(() => {
  const v = validatePlan(basePlan({
    heads: [
      { headType: 'MEAL_CARD', componentId: 'comp-meal', monthlyCapRupees: 2200, proofRequired: false, claimType: null },
    ],
  }));
  ok(v.ok === true, 'FBP-2: proof-free meal with a monthly cap (no annual) is valid');
})();

// ── FBP-2: a proof-free head with cap 0 is NOT a finite cap (rejected) ──
(() => {
  const v = validatePlan(basePlan({
    heads: [
      { headType: 'MEAL_CARD', componentId: 'comp-meal', annualCapRupees: 0, monthlyCapRupees: 0, proofRequired: false, claimType: null },
    ],
  }));
  ok(v.ok === false, 'FBP-2: a proof-free head capped at 0 is rejected (0 is not a usable cap)');
  eq(v.code, 'FBP_PROOFFREE_NO_CAP', 'FBP-2: cap-0 rejection code is FBP_PROOFFREE_NO_CAP');
})();

// ── FBP-1/2 FIX: only MEAL_CARD may be proof-free — a proof-free FUEL_CAR is rejected ──
(() => {
  const v = validatePlan(basePlan({
    heads: [
      { headType: 'MEAL_CARD', componentId: 'comp-meal', monthlyCapRupees: 2200, proofRequired: false, claimType: null },
      // the exploit shape: a fuel head authored proof-free (with a cap, to isolate THIS rule)
      { headType: 'FUEL_CAR', componentId: 'comp-fuel', annualCapRupees: 21600, proofRequired: false, claimType: null },
    ],
  }));
  ok(v.ok === false, 'FBP-1/2: a proof-free NON-meal head (FUEL_CAR) is REJECTED at plan save');
  eq(v.code, 'FBP_PROOFFREE_NOT_MEAL', 'FBP-1/2: rejection code is FBP_PROOFFREE_NOT_MEAL');
})();

// ── a proof-REQUIRED head with no cap is still fine (bills self-cap it) ──
(() => {
  const v = validatePlan(basePlan({
    heads: [
      { headType: 'MEAL_CARD', componentId: 'comp-meal', monthlyCapRupees: 2200, proofRequired: false, claimType: null },
      { headType: 'LTA', componentId: 'comp-lta', proofRequired: true, claimType: 'FBP_LTA' }, // uncapped, but proof-required
    ],
  }));
  ok(v.ok === true, 'a proof-required head may be uncapped (the verified bill Σ bounds it)');
})();

// ── the India template itself still validates (no regression from the new rules) ──
(() => {
  const { indiaFbpHeadTemplate } = require('../fbpPlan');
  const heads = indiaFbpHeadTemplate().map((h, i) => ({ ...h, componentId: `comp-tmpl-${i}` }));
  const v = validatePlan({ envelopeComponentId: ENV, heads });
  ok(v.ok === true, 'the India FBP head template validates under the new proof-free cap rules');
})();

console.log(`\nFeature 25 fbpPlan (validatePlan) test: ${pass} passed, ${fail} failed.`);
assert.strictEqual(fail, 0, 'fbpPlan validatePlan tests must all pass');
