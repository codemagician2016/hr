'use strict';

/*
 * openShiftClaim.unit.test.js — the PURE open-shift claim logic (no DB).
 *
 * Covers the three pieces the OPEN_SHIFT_CLAIM consumer leans on:
 *   1. applyClaimFill({headcount, filledCount}) — the slot-fill / FILLED decision
 *      (drives the atomic increment + the auto-reject-losers branch).
 *   2. rosterDayClaimShape(openShift) — the RosterDay create/update shape a confirmed
 *      claim writes (PUBLISHED WORK cell, OPEN_CLAIM provenance, shift's pattern).
 *   3. claimTransition(hook, currentStatus) — the PENDING-guarded status transitions
 *      (idempotent: any non-PENDING current → null no-op).
 * Plain-node, mirrors the otPreApproval.unit style:
 *   node backend/src/hr/approvals/__tests__/openShiftClaim.unit.test.js
 */

const assert = require('assert');
const { applyClaimFill, rosterDayClaimShape, claimTransition } = require('../consumers.openShiftClaim');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }
function eq(name, a, b) { assert.deepStrictEqual(a, b, name); passed += 1; }

// ── 1. applyClaimFill ─────────────────────────────────────────────────────────
// Single-slot shift: the first claim fills it.
eq('1-slot, 0 filled → FILLED + reject others', applyClaimFill({ headcount: 1, filledCount: 0 }),
  { newFilled: 1, newStatus: 'FILLED', shouldRejectOthers: true });

// Multi-slot: not full until the last slot lands.
eq('3-slot, 0 filled → OPEN, no reject', applyClaimFill({ headcount: 3, filledCount: 0 }),
  { newFilled: 1, newStatus: 'OPEN', shouldRejectOthers: false });
eq('3-slot, 1 filled → OPEN, no reject', applyClaimFill({ headcount: 3, filledCount: 1 }),
  { newFilled: 2, newStatus: 'OPEN', shouldRejectOthers: false });
eq('3-slot, 2 filled → FILLED + reject others', applyClaimFill({ headcount: 3, filledCount: 2 }),
  { newFilled: 3, newStatus: 'FILLED', shouldRejectOthers: true });

// Defensive: an over-filled / already-at-capacity read still reports FILLED (never OPEN).
eq('at capacity (3/3) → FILLED (never re-opens)', applyClaimFill({ headcount: 3, filledCount: 3 }),
  { newFilled: 4, newStatus: 'FILLED', shouldRejectOthers: true });

// Coercion / bad input: headcount defaults to at least 1, negative filled clamps to 0.
eq('headcount missing → treated as 1 → FILLED', applyClaimFill({ filledCount: 0 }),
  { newFilled: 1, newStatus: 'FILLED', shouldRejectOthers: true });
eq('headcount 0 coerced to 1 → FILLED', applyClaimFill({ headcount: 0, filledCount: 0 }),
  { newFilled: 1, newStatus: 'FILLED', shouldRejectOthers: true });
eq('negative filled clamps to 0 (2-slot) → OPEN', applyClaimFill({ headcount: 2, filledCount: -5 }),
  { newFilled: 1, newStatus: 'OPEN', shouldRejectOthers: false });
eq('no args at all → defaults 1-slot FILLED', applyClaimFill(),
  { newFilled: 1, newStatus: 'FILLED', shouldRejectOthers: true });

// ── 2. rosterDayClaimShape ────────────────────────────────────────────────────
const shape = rosterDayClaimShape({ id: 'os1', shiftPatternId: 'pat-night', date: '2026-08-01' });
eq('roster cell shape is PUBLISHED WORK OPEN_CLAIM on the shift pattern', shape,
  { dayType: 'WORK', shiftPatternId: 'pat-night', source: 'OPEN_CLAIM', status: 'PUBLISHED' });
ok('shape carries the OpenShift pattern verbatim', shape.shiftPatternId === 'pat-night');
ok('shape never emits a swap/rotation provenance', shape.source === 'OPEN_CLAIM');

// ── 3. claimTransition (PENDING-guarded, idempotent) ──────────────────────────
ok('onApprove from PENDING → APPROVED', claimTransition('onApprove', 'PENDING') === 'APPROVED');
ok('onReject from PENDING → REJECTED', claimTransition('onReject', 'PENDING') === 'REJECTED');
ok('onCancel from PENDING → CANCELLED', claimTransition('onCancel', 'PENDING') === 'CANCELLED');
// Idempotency: any already-terminal current status is a no-op (null) for every hook.
for (const cur of ['APPROVED', 'REJECTED', 'CANCELLED']) {
  ok(`onApprove no-ops from ${cur}`, claimTransition('onApprove', cur) === null);
  ok(`onReject no-ops from ${cur}`, claimTransition('onReject', cur) === null);
  ok(`onCancel no-ops from ${cur}`, claimTransition('onCancel', cur) === null);
}
ok('unknown hook → null', claimTransition('onWhatever', 'PENDING') === null);

console.log(`openShiftClaim.unit: ${passed} checks passed`);
