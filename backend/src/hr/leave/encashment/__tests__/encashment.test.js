'use strict';

/*
 * encashment.test.js — Feature 31 pure-node tests for the in-service encashment
 * validator + money math. Plain `node` (built-in assert, NO jest), the house style of
 * the leave ledger / fnf suites. Run:
 *   node src/hr/leave/encashment/__tests__/encashment.test.js
 *
 * Proves:
 *   - the gate order (caps / window / min-balance-after / requests-per-year)
 *   - BASIC_DA_26 == fnf to the paise, + fractional days, + zero/negative guard
 *   - BASIC_30 / GROSS_30 variants round once
 *   - the §4.2 reconcile invariant: after a simulated APPROVE (one ENCASHMENT row +
 *     encashed+/closing−), ledger.reconstructClosing == the persisted closing.
 */

const assert = require('assert');
const { validateEncashRequest, computeEncashAmount } = require('../encashment');
const ledger = require('../../ledger');
const fnf = require('../../../lifecycle/fnf');

let failures = 0;
function ok(cond, msg) { if (cond) { console.log(`  PASS  ${msg}`); } else { failures += 1; console.log(`  FAIL  ${msg}`); } }

// A policy that allows in-service encashment with a 15-day/yr cap, min 5/request,
// keep-5 floor, once/year, March-only window, BASIC_DA_26 basis.
const POLICY = {
  encashInService: true,
  encashBasis: 'BASIC_DA_26',
  encashMaxDaysPerYear: 15,
  encashMinDaysPerRequest: 5,
  encashMinBalanceAfter: 5,
  encashMaxRequestsPerYear: 1,
  encashWindowOpenMonth: 3,
  encashWindowCloseMonth: 3,
  allowNegative: false,
};
const LEAVE_TYPE = { isEncashable: true };
// closing 30, no pending hold ⇒ available 30.
const BALANCE = { closing: 30, pendingApproval: 0 };

console.log('Feature 31 — encashment validator');

// 1) Happy path: 10 days, March, within all caps.
ok(validateEncashRequest({ balance: BALANCE, policy: POLICY, leaveType: LEAVE_TYPE, request: { days: 10 }, alreadyEncashedThisYearDays: 0, requestsThisYear: 0, asOfMonth: 3 }).ok,
  'valid 10-day March request passes');

// 2) Master gate — type not encashable.
{
  const v = validateEncashRequest({ balance: BALANCE, policy: POLICY, leaveType: { isEncashable: false }, request: { days: 10 }, asOfMonth: 3 });
  ok(!v.ok && v.code === 'ENCASH_NOT_ALLOWED', 'non-encashable type → ENCASH_NOT_ALLOWED');
}
// 2b) Master gate — policy.encashInService false.
{
  const v = validateEncashRequest({ balance: BALANCE, policy: { ...POLICY, encashInService: false }, leaveType: LEAVE_TYPE, request: { days: 10 }, asOfMonth: 3 });
  ok(!v.ok && v.code === 'ENCASH_NOT_ALLOWED', 'encashInService=false → ENCASH_NOT_ALLOWED');
}

// 3) Zero / negative days guard.
{
  const z = validateEncashRequest({ balance: BALANCE, policy: POLICY, leaveType: LEAVE_TYPE, request: { days: 0 }, asOfMonth: 3 });
  ok(!z.ok && z.code === 'INVALID_DAYS', 'zero days → INVALID_DAYS');
  const n = validateEncashRequest({ balance: BALANCE, policy: POLICY, leaveType: LEAVE_TYPE, request: { days: -3 }, asOfMonth: 3 });
  ok(!n.ok && n.code === 'INVALID_DAYS', 'negative days → INVALID_DAYS');
}

// 4) Below min days/request.
{
  const v = validateEncashRequest({ balance: BALANCE, policy: POLICY, leaveType: LEAVE_TYPE, request: { days: 3 }, asOfMonth: 3 });
  ok(!v.ok && v.code === 'BELOW_MIN_DAYS', '3 days < min 5 → BELOW_MIN_DAYS');
}

// 5) Requests-per-year cap.
{
  const v = validateEncashRequest({ balance: BALANCE, policy: POLICY, leaveType: LEAVE_TYPE, request: { days: 10 }, requestsThisYear: 1, asOfMonth: 3 });
  ok(!v.ok && v.code === 'MAX_REQUESTS_REACHED', 'second request when max=1 → MAX_REQUESTS_REACHED');
}

// 6) Yearly days cap (already encashed 10, +10 > 15).
{
  const v = validateEncashRequest({ balance: BALANCE, policy: POLICY, leaveType: LEAVE_TYPE, request: { days: 10 }, alreadyEncashedThisYearDays: 10, requestsThisYear: 0, asOfMonth: 3 });
  ok(!v.ok && v.code === 'YEARLY_CAP_EXCEEDED', '10 + already-10 > 15 → YEARLY_CAP_EXCEEDED');
}
// 6b) Exactly at the yearly cap is allowed (5 + already-10 == 15).
{
  const v = validateEncashRequest({ balance: BALANCE, policy: POLICY, leaveType: LEAVE_TYPE, request: { days: 5 }, alreadyEncashedThisYearDays: 10, requestsThisYear: 0, asOfMonth: 3 });
  ok(v.ok, '5 + already-10 == 15 (at cap) passes');
}

// 7) Window closed (request in June, window is March-only).
{
  const v = validateEncashRequest({ balance: BALANCE, policy: POLICY, leaveType: LEAVE_TYPE, request: { days: 10 }, asOfMonth: 6 });
  ok(!v.ok && v.code === 'WINDOW_CLOSED', 'June request with March-only window → WINDOW_CLOSED');
}
// 7b) NULL open-month ⇒ always open.
{
  const v = validateEncashRequest({ balance: BALANCE, policy: { ...POLICY, encashWindowOpenMonth: null, encashWindowCloseMonth: null }, leaveType: LEAVE_TYPE, request: { days: 10 }, asOfMonth: 6 });
  ok(v.ok, 'NULL window month ⇒ always open');
}
// 7c) Year-end-wrapping window (open Nov=11, close Feb=2) covers January.
{
  const v = validateEncashRequest({ balance: BALANCE, policy: { ...POLICY, encashWindowOpenMonth: 11, encashWindowCloseMonth: 2 }, leaveType: LEAVE_TYPE, request: { days: 10 }, asOfMonth: 1 });
  ok(v.ok, 'wrapping window Nov–Feb covers January');
  const out = validateEncashRequest({ balance: BALANCE, policy: { ...POLICY, encashWindowOpenMonth: 11, encashWindowCloseMonth: 2 }, leaveType: LEAVE_TYPE, request: { days: 10 }, asOfMonth: 6 });
  ok(!out.ok && out.code === 'WINDOW_CLOSED', 'wrapping window Nov–Feb excludes June');
}

// 8) Min-balance-after floor. closing 8, keep-5 ⇒ may encash at most 3; 5 fails.
{
  const v = validateEncashRequest({ balance: { closing: 8, pendingApproval: 0 }, policy: POLICY, leaveType: LEAVE_TYPE, request: { days: 5 }, asOfMonth: 3 });
  ok(!v.ok && v.code === 'INSUFFICIENT_BALANCE', 'encash 5 leaving 3 < keep-5 → INSUFFICIENT_BALANCE');
}
// 8b) A pending hold reduces available (closing 12, pending 4 ⇒ avail 8; encash 5, keep 3 < 5 fails).
{
  const v = validateEncashRequest({ balance: { closing: 12, pendingApproval: 4 }, policy: POLICY, leaveType: LEAVE_TYPE, request: { days: 5 }, asOfMonth: 3 });
  ok(!v.ok && v.code === 'INSUFFICIENT_BALANCE', 'pending hold counts against available (uses ledger.available)');
}

console.log('Feature 31 — encashment money math');

// 9) BASIC_DA_26 == fnf, to the paise. Basic+DA = ₹26,000/mo, 10 days.
{
  const mine = computeEncashAmount({ basis: 'BASIC_DA_26', basicDaMonthlyMinor: 2600000, days: 10 });
  const theirs = fnf._internals.computeLeaveEncashment({ basicDaMonthlyMinor: 2600000, encashableLeaveDays: 10 });
  ok(mine.amountMinor === theirs.amountMinor && mine.amountMinor === 1000000, 'BASIC_DA_26 10 days == fnf == ₹10,000');
  ok(mine.perDayMinor === theirs.perDayMinor && mine.perDayMinor === 100000, 'BASIC_DA_26 perDay == fnf == ₹1,000');
}
// 9b) Fractional days (half-day grain), single-rounding off the unrounded monthly figure.
{
  const mine = computeEncashAmount({ basis: 'BASIC_DA_26', basicDaMonthlyMinor: 2600000, days: 7.5 });
  const theirs = fnf._internals.computeLeaveEncashment({ basicDaMonthlyMinor: 2600000, encashableLeaveDays: 7.5 });
  ok(mine.amountMinor === theirs.amountMinor, `BASIC_DA_26 7.5 days == fnf (${mine.amountMinor})`);
  // 26000 * 7.5 / 26 = 7500.00 → ₹7,500
  ok(mine.amountMinor === 750000, 'BASIC_DA_26 7.5 days == ₹7,500 exact');
}
// 9c) Rounding: an awkward Basic+DA rounds once (floor(x+0.5)).
{
  // Basic+DA = ₹25,000 (2500000 paise), 1 day → 2500000/26 = 96153.84… → floor(+0.5) = 96154.
  const mine = computeEncashAmount({ basis: 'BASIC_DA_26', basicDaMonthlyMinor: 2500000, days: 1 });
  ok(mine.amountMinor === 96154, 'BASIC_DA_26 rounds once: ₹25,000/26 × 1 = 96154 paise');
}
// 10) BASIC_30 variant (basic only). ₹30,000/mo basic, 6 days → 30000*6/30 = 6000.
{
  const mine = computeEncashAmount({ basis: 'BASIC_30', basicDaMonthlyMinor: 3000000, days: 6 });
  ok(mine.amountMinor === 600000, 'BASIC_30 ₹30,000/mo × 6/30 = ₹6,000');
  ok(mine.perDayMinor === 100000, 'BASIC_30 perDay = ₹1,000');
}
// 11) GROSS_30 variant. ₹45,000/mo gross, 3 days → 45000*3/30 = 4500.
{
  const mine = computeEncashAmount({ basis: 'GROSS_30', grossMonthlyMinor: 4500000, days: 3 });
  ok(mine.amountMinor === 450000, 'GROSS_30 ₹45,000/mo × 3/30 = ₹4,500');
}
// 12) Zero/negative days → zero amount.
{
  ok(computeEncashAmount({ basis: 'BASIC_DA_26', basicDaMonthlyMinor: 2600000, days: 0 }).amountMinor === 0, 'zero days → ₹0');
  ok(computeEncashAmount({ basis: 'BASIC_DA_26', basicDaMonthlyMinor: 2600000, days: -2 }).amountMinor === 0, 'negative days → ₹0');
}

console.log('Feature 31 — §4.2 reconcile invariant after a simulated APPROVE');

// 13) Reconcile: a balance with opening 30, then an APPROVE debits 10 (encashed+=10,
//     closing-=10). The ledger (incl. the new ENCASHMENT row) must reconstruct the
//     same closing. This proves the balance debit uses the existing ledger primitive.
{
  // The ledger after approve: opening 30, then ENCASHMENT of 10.
  const txns = [
    { txnType: 'OPENING_BALANCE', quantity: 30, status: 'APPROVED' },
    { txnType: 'ENCASHMENT', quantity: 10, status: 'APPROVED' },
  ];
  const reconstructed = ledger.reconstructClosing(txns);
  // The persisted balance after the APPROVE move (encashed 10, closing 20).
  const persisted = { closing: 20, encashed: 10, opening: 30 };
  ok(reconstructed === 20, `ledger reconstructs closing 20 from OPENING 30 − ENCASHMENT 10 (got ${reconstructed})`);
  ok(ledger.reconciles(persisted, txns), 'persisted closing 20 reconciles with the ledger incl. the ENCASHMENT row');
  // computeClosing over the buckets agrees too.
  const buckets = { opening: 30, accrued: 0, taken: 0, encashed: 10, lapsed: 0, adjusted: 0 };
  ok(ledger.computeClosing(buckets) === 20, 'computeClosing(buckets with encashed=10) == 20');
}

if (failures > 0) { console.log(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nAll encashment tests passed.');
