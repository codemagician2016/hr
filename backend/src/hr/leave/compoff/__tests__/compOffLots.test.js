'use strict';

/*
 * compOffLots.test.js — pure-unit golden test for the comp-off lot math
 * (../compOffLots.js). Plain-node (built-in assert, no jest):
 *   node backend/src/hr/leave/compoff/__tests__/compOffLots.test.js
 *
 * Proves the Feature 30 §7 invariants that are PURE:
 *   5. FIFO — allocateFromLots never burns a later-expiring lot while an earlier one
 *      has remaining.
 *   6. no spend-after-expiry — an EXPIRED lot's residual is never allocatable; the
 *      withdraw re-credit never restores an expired lot.
 *   + thousandths precision on 0.5-day lots, the earliest-expiry gate, and the
 *     aggregate↔lots sum (invariant 1's pure half).
 */

const assert = require('assert');
const L = require('../compOffLots');

let passed = 0; let failed = 0; const fails = [];
function ok(cond, msg) { if (cond) { passed += 1; } else { failed += 1; fails.push(msg); } }
function eq(a, b, msg) { ok(Math.abs(Number(a) - Number(b)) < 1e-9, `${msg} (got ${a}, want ${b})`); }
function eqStr(a, b, msg) { ok(String(a) === String(b), `${msg} (got ${a}, want ${b})`); }

function lot(id, qty, consumed, expiresOn, earnedOn) {
  return { id, quantity: qty, consumed: consumed || 0, expiresOn, earnedOn: earnedOn || '2026-01-01' };
}

// ── FIFO ordering (invariant 5) ──────────────────────────────────────────────
{
  const lots = [
    lot('B', 1, 0, '2026-08-01'),
    lot('A', 1, 0, '2026-06-01'), // soonest → burned first
    lot('C', 1, 0, '2026-10-01'),
  ];
  const { allocations } = L.allocateFromLots(lots, 1.5);
  eq(allocations.length, 2, 'FIFO: 1.5 units spans the two soonest lots');
  eq(allocations[0].lotId === 'A', true, 'FIFO: lot A (soonest expiry) burned first');
  eq(allocations[0].take, 1, 'FIFO: full 1.0 from A');
  eq(allocations[0].exhausts, true, 'FIFO: A is exhausted');
  eq(allocations[1].lotId === 'B', true, 'FIFO: lot B (next) burned second');
  eq(allocations[1].take, 0.5, 'FIFO: 0.5 from B');
  eq(allocations[1].exhausts, false, 'FIFO: B partially consumed (not exhausted)');
}

// ── half-day thousandths precision ───────────────────────────────────────────
{
  const lots = [lot('H1', 0.5, 0, '2026-07-01'), lot('H2', 0.5, 0, '2026-07-15')];
  const { allocations, total } = L.allocateFromLots(lots, 0.5);
  eq(total, 0.5, 'half-day: total 0.5');
  eq(allocations.length, 1, 'half-day: one lot covers 0.5');
  eq(allocations[0].newConsumed, 0.5, 'half-day: newConsumed 0.5 (exact)');
  eq(allocations[0].exhausts, true, 'half-day: 0.5 lot fully consumed by a 0.5 avail');
}

// ── insufficient → throws INSUFFICIENT_COMP_OFF ──────────────────────────────
{
  let threw = null;
  try { L.allocateFromLots([lot('X', 1, 0, '2026-06-01')], 2); } catch (e) { threw = e; }
  ok(threw && threw.code === 'INSUFFICIENT_COMP_OFF', 'insufficient lots → INSUFFICIENT_COMP_OFF');
  eq(threw && threw.shortfall, 1, 'shortfall reported as 1');
}

// ── lapseLots: only expired-with-remaining lapse (invariant 6) ───────────────
{
  const asOf = '2026-07-10';
  const lots = [
    lot('L1', 1, 0, '2026-07-01'),     // expired, remaining 1 → lapses
    lot('L2', 1, 0.5, '2026-06-15'),   // expired, remaining 0.5 → lapses 0.5
    lot('L3', 1, 1, '2026-06-01'),     // expired but fully consumed → no lapse
    lot('L4', 1, 0, '2026-08-01'),     // not expired → no lapse
  ];
  const { lots: lapsed, total } = L.lapseLots(lots, asOf);
  eq(total, 1.5, 'lapseLots: total residual 1.5 lapses');
  eq(lapsed.length, 2, 'lapseLots: only the two expired-with-remaining lots');
  ok(lapsed.find((x) => x.lotId === 'L1' && x.lapsed === 1), 'L1 lapses 1.0');
  ok(lapsed.find((x) => x.lotId === 'L2' && x.lapsed === 0.5), 'L2 lapses 0.5');
}

// ── earliestExpiryForUnits drives the COMP_OFF_WOULD_BE_EXPIRED gate ──────────
{
  const lots = [lot('A', 1, 0, '2026-06-01'), lot('B', 1, 0, '2026-09-01')];
  eqStr(L.earliestExpiryForUnits(lots, 1), '2026-06-01', 'gate: 1 unit needs only the soonest lot (exp 06-01)');
  eqStr(L.earliestExpiryForUnits(lots, 1.5), '2026-09-01', 'gate: 1.5 units reaches into the later lot (exp 09-01)');
  eq(L.earliestExpiryForUnits(lots, 5), null, 'gate: more than available → null (balance gate catches it)');
}

// ── reCreditToLots: un-burn LIFO, never restore an expired lot (invariant 6) ──
{
  // A burned 1.0; B burned 0.5; B expired before asOf → must NOT be re-credited.
  const asOf = '2026-07-10';
  const lots = [
    lot('A', 1, 1, '2026-09-01'),   // not expired, fully consumed
    lot('B', 1, 0.5, '2026-06-01'), // EXPIRED → ineligible for re-credit
  ];
  const { allocations, forfeited } = L.reCreditToLots(lots, 1.5, { asOf });
  // Only A (un-expired) can take the credit back; it had 1.0 consumed → returns 1.0.
  eq(allocations.length, 1, 're-credit: only the un-expired lot A is eligible');
  eq(allocations[0].lotId === 'A', true, 're-credit targets A');
  eq(allocations[0].newConsumed, 0, 're-credit: A consumed back to 0');
  eq(forfeited, 0.5, 're-credit: the 0.5 that lived in the now-expired lot B is forfeited');
}

// ── sumActiveRemaining (invariant 1, pure half) ──────────────────────────────
{
  const lots = [lot('A', 1, 0.25, 'x'), lot('B', 0.5, 0, 'y'), lot('C', 1, 1, 'z')];
  eq(L.sumActiveRemaining(lots), 1.25, 'sumActiveRemaining = 0.75 + 0.5 + 0 = 1.25');
}

console.log(`\ncompOffLots.test: ${passed} passed, ${failed} failed`);
if (failed) { fails.forEach((f) => console.log('  FAIL ', f)); process.exit(1); }
console.log('=== ALL compOffLots PURE CHECKS PASSED ===');
