'use strict';

/**
 * consumers.openShiftClaim.js — the OPEN_SHIFT_CLAIM consumer bundle (open shifts).
 *
 * An open shift is an UNASSIGNED shift the roster manager publishes to a pool;
 * eligible employees CLAIM it, and each claim rides its OWN WorkflowModule
 * (OPEN_SHIFT_CLAIM, built-in REPORTING_MANAGER chain — the claimant's manager
 * confirms). These callbacks carry the domain effect INSIDE the engine transaction
 * so the roster write commits atomically with the approval (mirrors
 * consumers.shiftSwap.js):
 *
 *   onApprove(req, tx) — PENDING → APPROVED: re-validate the shift is still OPEN, flip
 *                        the claim, UPSERT the claimant's RosterDay for the shift day
 *                        (source=OPEN_CLAIM, PUBLISHED, WORK, shift's pattern — honours
 *                        @@unique(businessId,employeeId,date) + the version optlock),
 *                        ATOMICALLY increment OpenShift.filledCount (guarded so
 *                        concurrent approvals can never over-fill), flip the shift to
 *                        FILLED when the last slot lands, then recompute the day. When
 *                        the shift becomes FILLED, the OTHER pending claims are
 *                        auto-REJECTED and their manager tasks cancelled.
 *   onReject(req, tx)  — PENDING → REJECTED: shift + roster untouched.
 *   onCancel(req, tx)  — claimant withdrew → CANCELLED: shift + roster untouched.
 *
 * Every flip is conditional (updateMany guarded on status=PENDING / a version lock /
 * filledCount<headcount) so a duplicate / re-fired hook or a race is a safe no-op —
 * a lost race throws DECISION_RACE and the whole engine tx rolls back. Self-registers
 * on load like the others.
 */

const consumers = require('./consumers');
const engine = require('./engine');
const { recompute } = require('../attendance/service');

function utcDay(value) {
  const t = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

class OpenShiftGuardError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code; // OPEN_SHIFT_MISSING | OPEN_SHIFT_NOT_OPEN | OPEN_SHIFT_FULL
  }
}

// ── PURE fill logic (unit-tested, no DB) ────────────────────────────────────────
// Given a shift's headcount + PRE-increment filledCount, decide the post-claim state.
// newFilled = filledCount + 1; the shift is FILLED (and the losers should be rejected)
// once every slot is taken.
function applyClaimFill({ headcount, filledCount } = {}) {
  const hc = Math.max(1, Number(headcount) || 1);
  const prior = Math.max(0, Number(filledCount) || 0);
  const newFilled = prior + 1;
  const filled = newFilled >= hc;
  return { newFilled, newStatus: filled ? 'FILLED' : 'OPEN', shouldRejectOthers: filled };
}

// PURE claim-status transition table. A decision only lands from PENDING (idempotent —
// a re-fired hook on an already-terminal claim is a no-op, returning null). This is the
// exact guard the DB updateMany(status=PENDING) enforces, hoisted for unit testing.
const CLAIM_TERMINAL = { onApprove: 'APPROVED', onReject: 'REJECTED', onCancel: 'CANCELLED' };
function claimTransition(hook, currentStatus) {
  if (currentStatus !== 'PENDING') return null;
  return CLAIM_TERMINAL[hook] || null;
}

// The RosterDay create/update shape a confirmed claim writes for (claimant, shift day):
// a PUBLISHED WORK cell carrying the open shift's pattern, provenance OPEN_CLAIM.
function rosterDayClaimShape(openShift) {
  return {
    dayType: 'WORK',
    shiftPatternId: openShift.shiftPatternId,
    source: 'OPEN_CLAIM',
    status: 'PUBLISHED',
  };
}

// Load the OpenShiftClaim this ApprovalRequest gates. Tolerant of an already-terminal
// row (a re-fired/duplicate hook is then a no-op).
async function loadClaim(tx, approvalRequest) {
  return tx.openShiftClaim.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId },
  });
}

// When a shift is FILLED, the remaining PENDING claims lose — mark each REJECTED
// ("shift filled") and close its open manager task so the inbox item disappears. The
// engine.cancel re-fires onCancel for that claim, which is a no-op because the claim is
// already REJECTED (PENDING-guarded). Runs INSIDE the same engine tx.
async function rejectOtherClaims(tx, { businessId, openShiftId, keepClaimId }) {
  const others = await tx.openShiftClaim.findMany({
    where: { businessId, openShiftId, status: 'PENDING', id: { not: keepClaimId } },
    select: { id: true },
  });
  for (const o of others) {
    await tx.openShiftClaim.updateMany({
      where: { id: o.id, status: 'PENDING' },
      data: { status: 'REJECTED', decidedAt: new Date() },
    });
    const open = await tx.approvalRequest.findFirst({
      where: {
        businessId, module: 'OPEN_SHIFT_CLAIM', entityType: 'OpenShiftClaim',
        entityId: o.id, status: { in: ['PENDING', 'ESCALATED'] },
      },
    });
    if (open) {
      await engine.cancel({ approvalRequestId: open.id, actorUserId: 'SYSTEM', comment: 'Open shift filled' }, tx);
    }
  }
}

// onApprove — PENDING → APPROVED. Fill the slot + materialise the roster cell.
async function onApprove(approvalRequest, tx) {
  const claim = await loadClaim(tx, approvalRequest);
  if (!claim || claim.status !== 'PENDING') return; // already decided / withdrawn → no-op

  const shift = await tx.openShift.findFirst({ where: { id: claim.openShiftId, businessId: claim.businessId } });
  if (!shift) throw new OpenShiftGuardError('OPEN_SHIFT_MISSING', 'Open shift no longer exists');
  if (shift.status !== 'OPEN') throw new OpenShiftGuardError('OPEN_SHIFT_NOT_OPEN', `Open shift is ${shift.status}`);

  // 1. Flip THIS claim → APPROVED (conditional / idempotent).
  const flip = await tx.openShiftClaim.updateMany({
    where: { id: claim.id, status: 'PENDING' },
    data: { status: claimTransition('onApprove', claim.status), decidedByUserId: approvalRequest.decidedBy || null, decidedAt: new Date() },
  });
  if (flip.count === 0) {
    const e = new Error('Claim already decided concurrently'); e.code = 'DECISION_RACE'; throw e;
  }

  // 2. UPSERT the claimant's RosterDay for the shift day (respect @@unique + optlock).
  const day = utcDay(shift.date);
  const shape = rosterDayClaimShape(shift);
  const existing = await tx.rosterDay.findUnique({
    where: { businessId_employeeId_date: { businessId: claim.businessId, employeeId: claim.employeeId, date: day } },
  });
  if (existing) {
    const upd = await tx.rosterDay.updateMany({
      where: { id: existing.id, version: existing.version },
      data: { ...shape, rotationTemplateId: null, swapRequestId: null, version: { increment: 1 } },
    });
    if (upd.count === 0) {
      const e = new Error('Roster cell changed concurrently'); e.code = 'DECISION_RACE'; throw e;
    }
  } else {
    await tx.rosterDay.create({
      data: { businessId: claim.businessId, employeeId: claim.employeeId, date: day, ...shape },
    });
  }

  // 3. ATOMIC, race-safe fill: only increment while a slot remains + shift still OPEN.
  // The filledCount<headcount guard means two concurrent approvals for the same last
  // slot cannot both succeed — the loser matches 0 rows → DECISION_RACE → its tx rolls
  // back (and its RosterDay write with it). Flip to FILLED in the SAME write.
  const fill = applyClaimFill({ headcount: shift.headcount, filledCount: shift.filledCount });
  const inc = await tx.openShift.updateMany({
    where: { id: shift.id, status: 'OPEN', filledCount: { lt: shift.headcount } },
    data: { filledCount: { increment: 1 }, ...(fill.newStatus === 'FILLED' ? { status: 'FILLED' } : {}) },
  });
  if (inc.count === 0) {
    const e = new Error('Open shift is already full'); e.code = 'DECISION_RACE'; throw e;
  }

  // 4. Re-derive the claimant's day INSIDE the tx so the Attendance rollup reflects the
  //    newly-published shift atomically with the approval.
  await recompute(claim.businessId, claim.employeeId, day, day, tx);

  // 5. Shift now FILLED → auto-reject the losers + close their manager tasks.
  if (fill.shouldRejectOthers) {
    await rejectOtherClaims(tx, { businessId: claim.businessId, openShiftId: shift.id, keepClaimId: claim.id });
  }
}

// onReject — PENDING → REJECTED. Shift + roster untouched.
async function onReject(approvalRequest, tx) {
  const claim = await loadClaim(tx, approvalRequest);
  const next = claim && claimTransition('onReject', claim.status);
  if (!next) return;
  await tx.openShiftClaim.updateMany({
    where: { id: claim.id, status: 'PENDING' },
    data: { status: next, decidedByUserId: approvalRequest.decidedBy || null, decidedAt: new Date() },
  });
}

// onCancel — claimant withdrew → CANCELLED. Shift + roster untouched.
async function onCancel(approvalRequest, tx) {
  const claim = await loadClaim(tx, approvalRequest);
  const next = claim && claimTransition('onCancel', claim.status);
  if (!next) return;
  await tx.openShiftClaim.updateMany({
    where: { id: claim.id, status: 'PENDING' },
    data: { status: next, decidedByUserId: approvalRequest.decidedBy || null, decidedAt: new Date() },
  });
}

const bundle = { onApprove, onReject, onCancel };

function registerOpenShiftClaimConsumer() {
  return consumers.register('OPEN_SHIFT_CLAIM', bundle);
}

// Self-register on module load (idempotent), mirroring consumers.shiftSwap.js.
registerOpenShiftClaimConsumer();

module.exports = {
  registerOpenShiftClaimConsumer,
  bundle,
  // exported for the controllers' reuse + unit tests
  applyClaimFill,
  rosterDayClaimShape,
  claimTransition,
  OpenShiftGuardError,
};
