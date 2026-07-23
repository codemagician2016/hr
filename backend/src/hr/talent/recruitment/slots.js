'use strict';

/**
 * slots.js — Feature 36 interview slot-proposal PURE logic (no DB, no I/O).
 *
 * The propose→confirm handshake keeps its side-effect-free decisions here so they
 * can be unit-tested directly: normalising the proposed slot options, finding a
 * chosen slot, and the confirm gate (the pure part of the conditional-update that
 * guards the double-confirm race), plus the leak-safe public projection (no panel
 * identities, no other applications).
 */

const crypto = require('crypto');

// Normalise a caller-supplied list of proposed options into stable
// [{ id, startAt(ISO), endAt(ISO|null) }] rows. Returns { slots } or { error }.
// Each option needs a valid startAt; endAt is optional (the interview's
// durationMins fills the gap on confirm).
function normalizeProposedSlots(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'At least one slot { startAt, endAt? } is required' };
  }
  if (raw.length > 20) return { error: 'At most 20 slots may be proposed' };
  const out = [];
  const seen = new Set();
  for (const s of raw) {
    if (!s || typeof s !== 'object') return { error: 'Each slot must be an object' };
    const start = s.startAt != null ? new Date(s.startAt) : null;
    if (!start || Number.isNaN(+start)) return { error: 'Each slot needs a valid startAt' };
    let endIso = null;
    if (s.endAt != null && s.endAt !== '') {
      const end = new Date(s.endAt);
      if (Number.isNaN(+end)) return { error: 'Invalid endAt' };
      if (+end <= +start) return { error: 'endAt must be after startAt' };
      endIso = end.toISOString();
    }
    const id = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : crypto.randomUUID();
    if (seen.has(id)) return { error: 'Duplicate slot id' };
    seen.add(id);
    out.push({ id, startAt: start.toISOString(), endAt: endIso });
  }
  return { slots: out };
}

// Find a proposed slot by id (or null). Tolerant of a missing/!array slots field.
function findProposedSlot(proposal, slotId) {
  const slots = proposal && Array.isArray(proposal.slots) ? proposal.slots : [];
  return slots.find((s) => s && s.id === slotId) || null;
}

// PURE confirm gate (the double-confirm race's decidable part). Returns
//   { ok:true, slot }              — the candidate may confirm this slot
//   { ok:false, code }             — NOT_FOUND | NOT_CONFIRMABLE | EXPIRED | BAD_SLOT
// The DB conditional update (status PROPOSED→CONFIRMED) is still the authority for
// the actual race; this decides everything else deterministically.
function confirmDecision(proposal, slotId, now = new Date()) {
  if (!proposal) return { ok: false, code: 'NOT_FOUND' };
  if (proposal.status !== 'PROPOSED') return { ok: false, code: 'NOT_CONFIRMABLE' };
  if (proposal.expiresAt && new Date(proposal.expiresAt).getTime() < now.getTime()) {
    return { ok: false, code: 'EXPIRED' };
  }
  const slot = findProposedSlot(proposal, slotId);
  if (!slot) return { ok: false, code: 'BAD_SLOT' };
  return { ok: true, slot };
}

// Leak-safe public projection of a proposal. Deliberately DROPS interviewId,
// businessId, proposedById and any panel identity — the candidate sees only the
// slot options + the outcome.
function publicSlotView(proposal) {
  if (!proposal) return null;
  return {
    proposalId: proposal.id,
    status: proposal.status,
    slots: (Array.isArray(proposal.slots) ? proposal.slots : []).map((s) => ({
      id: s.id, startAt: s.startAt, endAt: s.endAt || null,
    })),
    confirmedSlot: proposal.confirmedSlot || null,
    expiresAt: proposal.expiresAt || null,
  };
}

module.exports = {
  normalizeProposedSlots,
  findProposedSlot,
  confirmDecision,
  publicSlotView,
};
