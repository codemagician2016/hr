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

// ── reCreditAllocations: EXACT-lot re-credit + forfeit expired (findings #1/#5) ─
{
  // Withdraw debited L1 (now expired) for 1.0 and L2 (live) for 0.5. Re-credit must
  // restore L2 EXACTLY (not arbitrary reverse-FIFO) and FORFEIT the 1.0 from expired L1.
  const asOf = '2026-07-10';
  const byId = new Map([
    ['L1', lot('L1', 1, 1, '2026-06-01')],   // EXPIRED, was fully consumed → forfeit
    ['L2', lot('L2', 1, 0.5, '2026-09-01')], // live → re-credit exactly its 0.5
  ]);
  const allocs = [{ lotId: 'L1', units: 1 }, { lotId: 'L2', units: 0.5 }];
  const { moves, forfeited } = L.reCreditAllocations(allocs, byId, { asOf });
  eq(forfeited, 1, 'reCreditAllocations: the 1.0 from the EXPIRED lot L1 is forfeited (finding #1)');
  eq(moves.length, 1, 'reCreditAllocations: only the live lot L2 is re-credited');
  eq(moves[0].lotId === 'L2', true, 'reCreditAllocations: re-credits the EXACT debited lot L2 (finding #5)');
  eq(moves[0].newConsumed, 0, 'reCreditAllocations: L2 consumed back to 0');
  eq(moves[0].reactivates, true, 'reCreditAllocations: a fully-consumed lot dropping below qty reactivates → ACTIVE');
}
{
  // Cross-credit guard: an allocation must only touch its OWN lots. Even if a newer
  // lot (L3) has consumption from a DIFFERENT leave, reCreditAllocations never touches
  // it — it only un-burns the lotIds in `allocs`.
  const byId = new Map([
    ['L_mine', lot('L_mine', 1, 1, '2026-12-01')],
    ['L_other', lot('L_other', 1, 1, '2026-12-01')], // belongs to another leave
  ]);
  const { moves } = L.reCreditAllocations([{ lotId: 'L_mine', units: 1 }], byId, { asOf: '2026-06-01' });
  eq(moves.length, 1, 'cross-credit: only my lot is touched');
  eq(moves[0].lotId === 'L_mine', true, 'cross-credit: never restores another leave\'s lot (finding #5)');
}

// ── firstDayPastExpiry: per-day FIFO catches a span that expires MID-span (#4) ──
{
  // One 2.0-unit lot expiring 2026-08-13. A 3-day span 08-12..08-14 (2 working days
  // 08-12 + 08-14, with 08-13 a non-working day) — the START (08-12) is fine but the
  // LAST charged day 08-14 falls AFTER the lot's 08-13 expiry → must be flagged.
  const lots = [lot('E', 2, 0, '2026-08-13')];
  const days = [
    { date: '2026-08-12', fraction: 1 },
    { date: '2026-08-14', fraction: 1 },
  ];
  eqStr(L.firstDayPastExpiry(lots, days), '2026-08-14', 'per-day gate: flags 08-14 (after the 08-13 expiry) — finding #4');
  // The START-only check would have PASSED this (start 08-12 <= 08-13). Sanity:
  eqStr(L.earliestExpiryForUnits(lots, 2), '2026-08-13', 'start-only gate would see needed-expiry 08-13 (start 08-12 passes — the missed case)');
}
{
  // Whole span on/before expiry → no day flagged.
  const lots = [lot('E', 2, 0, '2026-08-20')];
  const days = [{ date: '2026-08-12', fraction: 1 }, { date: '2026-08-13', fraction: 1 }];
  eq(L.firstDayPastExpiry(lots, days), null, 'per-day gate: every day on/before expiry → null (allowed)');
}
{
  // Two lots: a soon-expiring 1.0 (08-13) covers day1 FIFO; the later 1.0 (09-01)
  // covers day2. Day2 (08-20) is past the FIRST lot but its covering lot (09-01) is
  // still live → allowed. Proves the check follows FIFO allocation, not blanket min.
  const lots = [lot('S', 1, 0, '2026-08-13'), lot('L', 1, 0, '2026-09-01')];
  const days = [{ date: '2026-08-10', fraction: 1 }, { date: '2026-08-20', fraction: 1 }];
  eq(L.firstDayPastExpiry(lots, days), null, 'per-day gate FIFO: day2 covered by the later live lot → allowed');
}

console.log(`\ncompOffLots.test: ${passed} passed, ${failed} failed`);
if (failed) { fails.forEach((f) => console.log('  FAIL ', f)); process.exit(1); }
console.log('=== ALL compOffLots PURE CHECKS PASSED ===');
