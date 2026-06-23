'use strict';

/**
 * policyEngine.test.js — pure unit tests for the Feature 11 travel-&-expense policy
 * validator. NO DB, NO network. Run: node --test src/hr/expenses/__tests__/policyEngine.test.js
 *
 * Proves each rule path: per-diem band, hotel level×tier, flight min-hours reject,
 * self-car per-km, transport fareCap, disallowed-mode reject, monthly cap, FLAG vs
 * HARD enforcement, most-specific-rule-wins, and the claim rollup.
 */

const test = require('node:test');
const assert = require('node:assert');
const { evaluateLine, rollupVerdict, bestMatch, VERDICT } = require('../policyEngine');

// A representative FLAG policy with all three tables populated.
function policy(enforcement = 'FLAG') {
  return {
    enforcement,
    perDiemRules: [
      { durationBand: 'FULL_24H', gradeRank: null, cityTier: null, foodCap: '800', incidentalCap: '200' }, // 1000 total
      { durationBand: 'HALF_12H', gradeRank: null, cityTier: null, foodCap: '400', incidentalCap: '100' }, // 500
    ],
    hotelRules: [
      { gradeRank: 3, cityTier: 'TIER_1', nightlyCap: '7000' },
      { gradeRank: 3, cityTier: 'TIER_2', nightlyCap: '5000' },
      { gradeRank: 5, cityTier: 'TIER_1', nightlyCap: '10000' },
    ],
    transportRules: [
      { mode: 'SELF_CAR', gradeRank: null, allowed: true, perKmRate: '12', fareCap: null },
      { mode: 'FLIGHT', gradeRank: 3, allowed: true, fareCap: '15000', minJourneyHrs: 12 },
      { mode: 'FLIGHT', gradeRank: 5, allowed: true, fareCap: '25000', minJourneyHrs: 6 },
      { mode: 'TRAIN', gradeRank: null, allowed: true, fareCap: '3000', travelClass: 'AC_3T' },
      { mode: 'TAXI_CAB', gradeRank: null, allowed: true, fareCap: '1500' },
      { mode: 'PUBLIC_TRANSPORT', gradeRank: 2, allowed: false },
    ],
  };
}

test('per-diem within the FULL_24H cap → OK', () => {
  const r = evaluateLine({ amount: '900', durationBand: 'FULL_24H' }, { policy: policy(), currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.OK);
  assert.equal(r.appliedCap, 1000);
});

test('per-diem over the cap (FLAG) → FLAGGED', () => {
  const r = evaluateLine({ amount: '1200', durationBand: 'FULL_24H' }, { policy: policy('FLAG'), currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.FLAGGED);
  assert.equal(r.appliedCap, 1000);
});

test('per-diem over the cap (HARD) → AUTO_REJECTED', () => {
  const r = evaluateLine({ amount: '1200', durationBand: 'FULL_24H' }, { policy: policy('HARD'), currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.AUTO_REJECTED);
});

test('hotel within the level×tier cap (3 nights) → OK', () => {
  const r = evaluateLine({ amount: '20000', nights: 3 }, { policy: policy(), gradeRank: 3, cityTier: 'TIER_1', currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.OK);
  assert.equal(r.appliedCap, 21000); // 7000 × 3
});

test('hotel OVER the level×tier cap → FLAGGED with the right cap', () => {
  // L3 TIER_2 nightly cap 5000 × 2 = 10000; claim 13000 over.
  const r = evaluateLine({ amount: '13000', nights: 2 }, { policy: policy(), gradeRank: 3, cityTier: 'TIER_2', currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.FLAGGED);
  assert.equal(r.appliedCap, 10000);
});

test('hotel with no matching level×tier rule → NO_POLICY (advisory, never silent block)', () => {
  const r = evaluateLine({ amount: '9000', nights: 1 }, { policy: policy(), gradeRank: 9, cityTier: 'TIER_3', currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.NO_POLICY);
});

test('flight UNDER min journey hours → AUTO_REJECTED regardless of FLAG mode', () => {
  // L3 flight needs ≥12h; this journey is 4h.
  const r = evaluateLine({ amount: '8000', transportMode: 'FLIGHT' }, { policy: policy('FLAG'), gradeRank: 3, journeyHours: 4, currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.AUTO_REJECTED);
  assert.match(r.reason, /Flight allowed only/);
});

test('flight at/above min journey hours and within fare cap → OK', () => {
  const r = evaluateLine({ amount: '14000', transportMode: 'FLIGHT' }, { policy: policy(), gradeRank: 3, journeyHours: 14, currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.OK);
  assert.equal(r.appliedCap, 15000);
});

test('flight over the fare cap (FLAG) → FLAGGED', () => {
  const r = evaluateLine({ amount: '18000', transportMode: 'FLIGHT' }, { policy: policy(), gradeRank: 3, journeyHours: 14, currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.FLAGGED);
  assert.equal(r.appliedCap, 15000);
});

test('most-specific level wins: L5 flight at 6h is OK (its own minJourneyHrs=6)', () => {
  const r = evaluateLine({ amount: '20000', transportMode: 'FLIGHT' }, { policy: policy(), gradeRank: 5, journeyHours: 7, currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.OK);
  assert.equal(r.appliedCap, 25000);
});

test('self-car within per-km allowance → OK', () => {
  const r = evaluateLine({ amount: '1100', transportMode: 'SELF_CAR', distanceKm: '100' }, { policy: policy(), gradeRank: 3, currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.OK);
  assert.equal(r.appliedCap, 1200); // 12 × 100
});

test('self-car over the computed mileage → FLAGGED', () => {
  const r = evaluateLine({ amount: '2000', transportMode: 'SELF_CAR', distanceKm: '100' }, { policy: policy(), gradeRank: 3, currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.FLAGGED);
  assert.equal(r.appliedCap, 1200);
});

test('disallowed mode for the level → AUTO_REJECTED (eligibility, not a soft cap)', () => {
  const r = evaluateLine({ amount: '50', transportMode: 'PUBLIC_TRANSPORT' }, { policy: policy('FLAG'), gradeRank: 2, currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.AUTO_REJECTED);
});

test('per-category monthly cap straddling month-to-date → over → FLAGGED', () => {
  const categoryPolicy = { maxPerClaim: '5000', dailyCap: null, maxPerMonth: '10000', requireReceipt: false, enforcement: 'FLAG' };
  const r = evaluateLine({ amount: '4000' }, { policy: {}, categoryPolicy, monthToDate: 7000, currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.FLAGGED);
  // The breaching check reports ITS cap — here the monthly cap (10000), since
  // 7000 month-to-date + 4000 this line = 11000 > 10000.
  assert.equal(r.appliedCap, 10000);
  assert.match(r.reason, /monthly cap/);
});

test('per-category requireReceipt with no receipt → FLAGGED', () => {
  const categoryPolicy = { maxPerClaim: '5000', requireReceipt: true, enforcement: 'FLAG' };
  const r = evaluateLine({ amount: '100' }, { policy: {}, categoryPolicy, currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.FLAGGED);
  assert.match(r.reason, /Receipt required/);
});

test('per-category HARD over per-claim → AUTO_REJECTED', () => {
  const categoryPolicy = { maxPerClaim: '5000', requireReceipt: false, enforcement: 'HARD' };
  const r = evaluateLine({ amount: '9000' }, { policy: {}, categoryPolicy, currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.AUTO_REJECTED);
});

test('no policy at all → NO_POLICY (passes, advisory)', () => {
  const r = evaluateLine({ amount: '5000', transportMode: 'FLIGHT' }, { policy: null, currencyCode: 'INR' });
  assert.equal(r.verdict, VERDICT.NO_POLICY);
});

test('rollup picks the worst verdict', () => {
  assert.equal(rollupVerdict(['OK', 'NO_POLICY', 'FLAGGED', 'OK']), 'FLAGGED');
  assert.equal(rollupVerdict(['OK', 'AUTO_REJECTED', 'FLAGGED']), 'AUTO_REJECTED');
  assert.equal(rollupVerdict(['NO_POLICY', 'NO_POLICY']), 'NO_POLICY');
  assert.equal(rollupVerdict(['OK', 'OK']), 'OK');
});

test('bestMatch returns the most specific rule', () => {
  const rules = [
    { gradeRank: null, cityTier: null, id: 'wild' },
    { gradeRank: 3, cityTier: null, id: 'level' },
    { gradeRank: 3, cityTier: 'TIER_1', id: 'both' },
  ];
  assert.equal(bestMatch(rules, { gradeRank: 3, cityTier: 'TIER_1' }).id, 'both');
  assert.equal(bestMatch(rules, { gradeRank: 3, cityTier: 'TIER_9' }).id, 'level');
  assert.equal(bestMatch(rules, { gradeRank: 9, cityTier: 'TIER_9' }).id, 'wild');
});
