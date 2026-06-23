'use strict';

/*
 * leave.reconcile.test.js — INDEPENDENT QA for the balance ledger (../ledger.js).
 * Plain-node:  node backend/src/hr/leave/__tests__/leave.reconcile.test.js
 *
 * Covers QA 4 (ledger integrity / closing identity). For a synthesised ledger
 * we recompute closing from the signed-quantity reducer and assert it equals the
 * §4.2 identity AND the persisted projection.
 */

const assert = require('assert');
const L = require('../ledger.js');

let passed = 0; let failed = 0; const fails = [];
function check(name, expected, actual) {
  let ok; try { assert.deepStrictEqual(actual, expected); ok = true; } catch (_) { ok = false; }
  if (ok) { passed++; } else { failed++; fails.push({ name, expected, actual }); }
}
function near(name, expected, actual, eps = 1e-9) {
  if (Math.abs(expected - actual) <= eps) passed++; else { failed++; fails.push({ name, expected, actual }); }
}

// ── closing identity ──────────────────────────────────────────────────────────
near('closing identity 6+9-2 = 13', 13, L.computeClosing({ opening: 6, accrued: 9, taken: 2 }));
near('closing with encash+lapse+adj', 5,
  L.computeClosing({ opening: 10, accrued: 4, taken: 3, encashed: 2, lapsed: 1, adjusted: -3 }));
near('pendingApproval NOT in closing', 13,
  L.computeClosing({ opening: 6, accrued: 9, taken: 2, pendingApproval: 4 }));

// ── available ─────────────────────────────────────────────────────────────────
near('available = closing - pending', 9, L.available({ closing: 13, pendingApproval: 4 }, {}));
near('available with negativeCap', 12,
  L.available({ closing: 10, pendingApproval: 3 }, { allowNegative: true, negativeCap: 5 }));
near('available ignores cap when allowNegative false', 7,
  L.available({ closing: 10, pendingApproval: 3 }, { allowNegative: false, negativeCap: 5 }));

// ── reconstruct closing from a full ledger ────────────────────────────────────
const ledger = [
  { txnType: 'OPENING_BALANCE', quantity: 6 },
  { txnType: 'ACCRUAL', quantity: 1.5 },
  { txnType: 'ACCRUAL', quantity: 1.5 },
  { txnType: 'APPLICATION', quantity: -2, status: 'APPROVED' },
  { txnType: 'APPLICATION', quantity: -1, status: 'PENDING' },   // soft-hold, NOT in closing
  { txnType: 'APPLICATION', quantity: -3, status: 'REJECTED' },  // released, NOT in closing
  { txnType: 'ADJUSTMENT', quantity: 0.5 },
  { txnType: 'LAPSE', quantity: -0.5 },
  { txnType: 'ENCASHMENT', quantity: -1 },
];
// 6 +1.5 +1.5 -2 +0.5 -0.5 -1 = 6.0
near('reconstructClosing over mixed ledger = 6.0', 6.0, L.reconstructClosing(ledger));

// reconstructBuckets full audit
const b = L.reconstructBuckets(ledger);
near('bucket opening', 6, b.opening);
near('bucket accrued', 3, b.accrued);
near('bucket taken (approved only)', 2, b.taken);
near('bucket pendingApproval (pending only)', 1, b.pendingApproval);
near('bucket encashed', 1, b.encashed);
near('bucket lapsed', 0.5, b.lapsed);
near('bucket adjusted', 0.5, b.adjusted);
near('bucket closing matches identity', 6.0, b.closing);

// ── reconciles() against a persisted projection ───────────────────────────────
check('reconciles true when persisted matches ledger', true,
  L.reconciles({ closing: 6.0 }, ledger));
check('reconciles false when persisted drifts', false,
  L.reconciles({ closing: 7.0 }, ledger));

// ── encashment write-back invariant: closing→0 via encashed, never taken ──────
// Settle posts ENCASHMENT -13 against a closing of 13 → closing 0, taken untouched.
const settleLedger = [
  { txnType: 'OPENING_BALANCE', quantity: 6 },
  { txnType: 'ACCRUAL', quantity: 9 },
  { txnType: 'APPLICATION', quantity: -2, status: 'APPROVED' },
  { txnType: 'ENCASHMENT', quantity: -13 },
];
near('encashment drives closing to 0', 0, L.reconstructClosing(settleLedger));
const sb = L.reconstructBuckets(settleLedger);
near('encash bucket = 13', 13, sb.encashed);
near('taken stays 2 (not 15)', 2, sb.taken);

// ── signedQuantity per-type ───────────────────────────────────────────────────
near('signed OPENING +', 6, L.signedQuantity({ txnType: 'OPENING_BALANCE', quantity: 6 }));
near('signed ACCRUAL + (abs)', 1.5, L.signedQuantity({ txnType: 'ACCRUAL', quantity: 1.5 }));
near('signed APPLICATION approved −', -2, L.signedQuantity({ txnType: 'APPLICATION', quantity: -2, status: 'APPROVED' }));
near('signed APPLICATION pending 0', 0, L.signedQuantity({ txnType: 'APPLICATION', quantity: -2, status: 'PENDING' }));
near('signed ENCASHMENT −', -3, L.signedQuantity({ txnType: 'ENCASHMENT', quantity: 3 }));
near('signed LAPSE −', -1, L.signedQuantity({ txnType: 'LAPSE', quantity: 1 }));
near('signed ADJUSTMENT signed', -2.5, L.signedQuantity({ txnType: 'ADJUSTMENT', quantity: -2.5 }));
near('signed CANCELLATION 0', 0, L.signedQuantity({ txnType: 'CANCELLATION', quantity: -2 }));

console.log(`\nleave.reconcile: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of fails) console.error('FAIL', f.name, JSON.stringify(f)); process.exit(1); }
