'use strict';
// Plain-node test (run: `node offer-wage-rule.test.js`). Asserts the offer
// 50%-rule pre-flight rejects a bad Basic+DA split and accepts a good one,
// reusing the SAME pure wage check the payroll engine uses (imported via the
// controller's offerWageCheck, which calls india.js _internals.computeStatutoryWages).
// No DB, no Express — purely the pure pre-flight function.
const assert = require('assert');
const { _internals } = require('../controllers/recruitment.controller');
const { offerWageCheck } = _internals;

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, `FAIL: ${label}`);
  passed += 1;
  // eslint-disable-next-line no-console
  console.log(`  ok - ${label}`);
}

// The 50% add-back rule is effective 2025-11-21 (Labour Codes). Use a joining
// date on/after that so the rule binds.
const joiningDate = '2026-07-01';

// ── BAD split: Basic+DA = 40% of gross -> must be blocked with WAGES_50_RULE.
const bad = offerWageCheck({
  countryCode: 'IN',
  currencyCode: 'INR',
  grossMonthly: 100000, // ₹1,00,000
  basicMonthly: 40000,  // ₹40,000 = 40% < 50%
  joiningDate,
});
ok('bad 40% split is rejected', bad.ok === false);
ok('bad split surfaces WAGES_50_RULE', bad.error && bad.error.code === 'WAGES_50_RULE');

// ── GOOD split: Basic+DA = 55% of gross -> must be accepted.
const good = offerWageCheck({
  countryCode: 'IN',
  currencyCode: 'INR',
  grossMonthly: 100000, // ₹1,00,000
  basicMonthly: 55000,  // ₹55,000 = 55% >= 50%
  joiningDate,
});
ok('good 55% split is accepted', good.ok === true);

// ── EXACTLY 50%: boundary is inclusive (>= 50%) -> accepted.
const boundary = offerWageCheck({
  countryCode: 'IN',
  currencyCode: 'INR',
  grossMonthly: 100000,
  basicMonthly: 50000, // exactly 50%
  joiningDate,
});
ok('exactly 50% split is accepted (inclusive boundary)', boundary.ok === true);

// ── Basic split via Basic + DA combined still satisfies 50%.
const withDa = offerWageCheck({
  countryCode: 'IN',
  currencyCode: 'INR',
  grossMonthly: 100000,
  basicMonthly: 30000,
  daMonthly: 25000, // Basic+DA = 55,000 = 55%
  joiningDate,
});
ok('Basic(30k)+DA(25k)=55% is accepted', withDa.ok === true);

// ── Non-India (USD) offer is outside the Code on Wages -> not blocked.
const usd = offerWageCheck({
  countryCode: 'US',
  currencyCode: 'USD',
  grossMonthly: 100000,
  basicMonthly: 10000, // 10% would breach if IN, but rule does not apply
  joiningDate,
});
ok('non-India offer skips the 50% rule', usd.ok === true && usd.applied === false);

// eslint-disable-next-line no-console
console.log(`\nAll ${passed} assertions passed.`);
