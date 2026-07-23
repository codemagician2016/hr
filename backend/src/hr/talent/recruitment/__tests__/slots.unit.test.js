'use strict';

/*
 * slots.unit.test.js — Feature 36 slot-proposal PURE logic: the confirm gate (the
 * decidable part of the double-confirm race, §7.4), slot normalisation, and the
 * leak-safe public projection. Plain-node, no DB:
 *   node backend/src/hr/talent/recruitment/__tests__/slots.unit.test.js
 */

const assert = require('assert');
const {
  normalizeProposedSlots, findProposedSlot, confirmDecision, publicSlotView,
} = require('../slots');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

/* ── normalizeProposedSlots ── */
{
  ok('empty → error', !!normalizeProposedSlots([]).error);
  ok('not-array → error', !!normalizeProposedSlots(null).error);
  ok('missing startAt → error', !!normalizeProposedSlots([{ endAt: '2026-08-01T10:00:00Z' }]).error);
  ok('endAt before start → error', !!normalizeProposedSlots([{ startAt: '2026-08-01T10:00:00Z', endAt: '2026-08-01T09:00:00Z' }]).error);

  const good = normalizeProposedSlots([
    { startAt: '2026-08-01T10:00:00Z', endAt: '2026-08-01T10:45:00Z' },
    { startAt: '2026-08-02T14:00:00Z' },
  ]);
  ok('valid → slots', Array.isArray(good.slots) && good.slots.length === 2);
  ok('each slot gets an id', good.slots.every((s) => typeof s.id === 'string' && s.id.length));
  ok('ids are unique', good.slots[0].id !== good.slots[1].id);
  ok('startAt normalised to ISO', good.slots[0].startAt === '2026-08-01T10:00:00.000Z');
  ok('endAt optional → null', good.slots[1].endAt === null);
  // a caller-supplied id is preserved (so confirm can reference it)
  const withId = normalizeProposedSlots([{ id: 'slot-A', startAt: '2026-08-01T10:00:00Z' }]);
  ok('caller id preserved', withId.slots[0].id === 'slot-A');
  ok('duplicate id → error', !!normalizeProposedSlots([{ id: 'x', startAt: '2026-08-01T10:00:00Z' }, { id: 'x', startAt: '2026-08-02T10:00:00Z' }]).error);
}

/* ── findProposedSlot ── */
{
  const proposal = { slots: [{ id: 'a', startAt: 'x' }, { id: 'b', startAt: 'y' }] };
  ok('finds by id', findProposedSlot(proposal, 'b').id === 'b');
  ok('missing id → null', findProposedSlot(proposal, 'zzz') === null);
  ok('tolerates no slots', findProposedSlot({}, 'a') === null);
}

/* ── confirmDecision — the pure part of the conditional-update race ── */
{
  const base = {
    id: 'p1', status: 'PROPOSED',
    slots: [{ id: 'a', startAt: '2026-08-01T10:00:00.000Z', endAt: '2026-08-01T10:45:00.000Z' }, { id: 'b', startAt: '2026-08-02T10:00:00.000Z', endAt: null }],
    expiresAt: '2999-01-01T00:00:00.000Z',
  };
  const good = confirmDecision(base, 'a');
  ok('valid confirm → ok + slot', good.ok === true && good.slot.id === 'a');

  ok('null proposal → NOT_FOUND', confirmDecision(null, 'a').code === 'NOT_FOUND');
  ok('bad slotId → BAD_SLOT', confirmDecision(base, 'nope').code === 'BAD_SLOT');

  const confirmed = { ...base, status: 'CONFIRMED' };
  ok('already CONFIRMED → NOT_CONFIRMABLE', confirmDecision(confirmed, 'a').code === 'NOT_CONFIRMABLE');
  const withdrawn = { ...base, status: 'WITHDRAWN' };
  ok('WITHDRAWN → NOT_CONFIRMABLE', confirmDecision(withdrawn, 'a').code === 'NOT_CONFIRMABLE');

  const expired = { ...base, expiresAt: '2000-01-01T00:00:00.000Z' };
  ok('past expiresAt → EXPIRED', confirmDecision(expired, 'a', new Date('2026-08-01T00:00:00Z')).code === 'EXPIRED');
  // a proposal with no expiry never expires
  const noExpiry = { ...base, expiresAt: null };
  ok('null expiresAt never EXPIRED', confirmDecision(noExpiry, 'a').ok === true);
}

/* ── publicSlotView — leak-safe projection (no panel identity, no interviewId) ── */
{
  const proposal = {
    id: 'p1', businessId: 'biz-1', interviewId: 'iv-1', proposedById: 'user-9',
    status: 'PROPOSED',
    slots: [{ id: 'a', startAt: 's1', endAt: 'e1' }, { id: 'b', startAt: 's2', endAt: null }],
    confirmedSlot: null, expiresAt: '2999-01-01T00:00:00.000Z',
  };
  const view = publicSlotView(proposal);
  ok('exposes proposalId/status/slots/expiresAt', view.proposalId === 'p1' && view.status === 'PROPOSED' && view.slots.length === 2);
  ok('NO interviewId leaked', !('interviewId' in view));
  ok('NO businessId leaked', !('businessId' in view));
  ok('NO proposedById (panel identity) leaked', !('proposedById' in view));
  ok('slots carry only id/startAt/endAt', Object.keys(view.slots[0]).sort().join(',') === 'endAt,id,startAt');
}

console.log(`slots.unit: ${passed} checks passed`);
