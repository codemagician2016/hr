'use strict';

/**
 * consumers.shiftSwap.js — Feature 29. The SHIFT_SWAP consumer bundle.
 *
 * A shift swap rides its OWN WorkflowModule (SHIFT_SWAP) so its consumer never
 * collides with any other module's handler. The engine decides WHEN the manager
 * chain completes; these callbacks carry the domain effect INSIDE the engine
 * transaction so the roster-cell swap commits atomically with the approval:
 *
 *   onApprove(req, tx) — PENDING → APPROVED: re-validate the guards (a swap requested
 *                        Monday + approved Thursday may now break rest / land on a
 *                        published holiday-leave / lose consent), then ATOMICALLY swap
 *                        the two RosterDay cells under version-optimistic locks, flip
 *                        the ShiftSwapRequest, and re-derive BOTH (employee,day) pairs.
 *   onReject(req, tx)  — PENDING → REJECTED: cells untouched. Notify.
 *   onCancel(req, tx)  — requester withdrew → CANCELLED: cells untouched. Notify.
 *
 * Invariants: I3 (a swap is atomic — both cells move or neither: a lost version race
 * → P2025 → the whole engine tx rolls back → controller maps to 409 DECISION_RACE).
 * Re-validation NEVER trusts the file-time check. Mirrors consumers.leave.js's
 * conditional-flip + version-lock discipline and self-registers like the others.
 */

const consumers = require('./consumers');
const notify = require('./notify');
const { recompute } = require('../attendance/service');
// Reuse the PURE 11h-rest clock comparison from the rotation generator — the swap
// re-validates rest against adjacent days with the SAME rule the planner saw.
const { _internals: rotationInternals } = require('../attendance/roster/rotation');
const { restMinutesBetween, MIN_REST_MINUTES } = rotationInternals;

function utcDay(value) {
  const t = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}
function dayKey(value) {
  return utcDay(value).toISOString().slice(0, 10);
}

class SwapGuardError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code; // SWAP_LOCKED_DAY | SWAP_REST_VIOLATION | SWAP_NIGHT_CONSENT | SWAP_LEAVE_CONFLICT | SWAP_CELL_MISSING | SWAP_NOT_PUBLISHED
  }
}

// Load the ShiftSwapRequest this ApprovalRequest gates. Tolerant of an already-terminal
// row (a re-fired/duplicate hook is then a no-op).
async function loadSwap(tx, approvalRequest) {
  return tx.shiftSwapRequest.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId },
  });
}

// Is (employee, civil-day) on a LOCKED Attendance row? A swap can NEVER mutate a cell
// in a frozen/closed period (E1) — reuses the same period-lock semantics as punches.
async function isDayLocked(tx, businessId, employeeId, day) {
  const row = await tx.attendance.findFirst({
    where: { businessId, employeeId, date: utcDay(day), isLocked: true },
    select: { id: true },
  });
  return !!row;
}

// Is (employee, civil-day) on approved/availed full-day leave? (E3 — refuse to move a
// cell that now sits on leave.)
async function isDayOnLeave(tx, businessId, employeeId, day) {
  const k = dayKey(day);
  const txns = await tx.leaveTransaction.findMany({
    where: {
      businessId, employeeId, txnType: 'APPLICATION',
      status: { in: ['APPROVED', 'AVAILED'] },
      startDate: { lte: utcDay(day) }, endDate: { gte: utcDay(day) },
    },
    select: { startDate: true, endDate: true, startHalf: true, endHalf: true },
  });
  return txns.some((t) => {
    const s = dayKey(t.startDate);
    const e = dayKey(t.endDate);
    if (k < s || k > e) return false;
    // a same-day half application is not a full-day block; everything else is.
    if (k === s && t.startHalf && s === e) return false;
    return true;
  });
}

// The employee's adjacent (prev/next) PUBLISHED roster cells around `day`, for the
// 11h-rest re-check after the swap lands `newPattern` on that cell.
async function restOkAfterPlacement(tx, businessId, employeeId, day, newPattern) {
  if (!newPattern) return true; // an OFF placement can never break rest
  const d = utcDay(day);
  const prevDay = new Date(d.getTime() - 86400000);
  const nextDay = new Date(d.getTime() + 86400000);
  const neighbours = await tx.rosterDay.findMany({
    where: {
      businessId, employeeId, status: 'PUBLISHED', dayType: 'WORK',
      date: { in: [prevDay, nextDay] },
    },
    include: { shiftPattern: true },
  });
  const prev = neighbours.find((n) => dayKey(n.date) === dayKey(prevDay));
  const next = neighbours.find((n) => dayKey(n.date) === dayKey(nextDay));
  if (prev && prev.shiftPattern) {
    const rest = restMinutesBetween(dayKey(prevDay), prev.shiftPattern, dayKey(d), newPattern);
    if (rest != null && rest < MIN_REST_MINUTES) return false;
  }
  if (next && next.shiftPattern) {
    const rest = restMinutesBetween(dayKey(d), newPattern, dayKey(nextDay), next.shiftPattern);
    if (rest != null && rest < MIN_REST_MINUTES) return false;
  }
  return true;
}

/**
 * applySwap(tx, swap) — the shared, guarded, atomic cell swap. Re-validates ALL guards
 * INSIDE the tx, then version-swaps the two cells. Throws a SwapGuardError (→ 409) or a
 * Prisma P2025 (lost version race → 409). Returns the two (employeeId, dayKey) pairs to
 * re-derive.
 */
async function applySwap(tx, swap) {
  const { businessId, requesterEmployeeId, counterpartyEmployeeId, requesterDate, counterpartyDate } = swap;

  // Load BOTH cells (each must be PUBLISHED & unlocked).
  const [cellA, cellB] = await Promise.all([
    tx.rosterDay.findFirst({
      where: { businessId, employeeId: requesterEmployeeId, date: utcDay(requesterDate) },
      include: { shiftPattern: true },
    }),
    tx.rosterDay.findFirst({
      where: { businessId, employeeId: counterpartyEmployeeId, date: utcDay(counterpartyDate) },
      include: { shiftPattern: true },
    }),
  ]);
  if (!cellA || !cellB) throw new SwapGuardError('SWAP_CELL_MISSING', 'A roster cell to swap no longer exists');
  if (cellA.status !== 'PUBLISHED' || cellB.status !== 'PUBLISHED') {
    throw new SwapGuardError('SWAP_NOT_PUBLISHED', 'Both roster cells must be published to swap');
  }

  // E1 — neither day may be in a locked Attendance period.
  const [lockA, lockB] = await Promise.all([
    isDayLocked(tx, businessId, requesterEmployeeId, requesterDate),
    isDayLocked(tx, businessId, counterpartyEmployeeId, counterpartyDate),
  ]);
  if (lockA || lockB) throw new SwapGuardError('SWAP_LOCKED_DAY', 'A day is in a locked attendance period');

  // E3 — neither day may now sit on approved full-day leave.
  const [leaveA, leaveB] = await Promise.all([
    isDayOnLeave(tx, businessId, requesterEmployeeId, requesterDate),
    isDayOnLeave(tx, businessId, counterpartyEmployeeId, counterpartyDate),
  ]);
  if (leaveA || leaveB) throw new SwapGuardError('SWAP_LEAVE_CONFLICT', 'A day is now on approved leave');

  // After the swap: A works cellB's shift on requesterDate; B works cellA's shift on
  // counterpartyDate. (dayType travels with the shift so an OFF↔WORK trade is honest.)
  const newForA = { shiftPatternId: cellB.shiftPatternId, dayType: cellB.dayType, pattern: cellB.shiftPattern };
  const newForB = { shiftPatternId: cellA.shiftPatternId, dayType: cellA.dayType, pattern: cellA.shiftPattern };

  // E6 — night-shift consent for whoever now lands on an isNightShift pattern.
  const [empA, empB] = await Promise.all([
    tx.employee.findFirst({ where: { id: requesterEmployeeId, businessId }, select: { nightShiftEligible: true } }),
    tx.employee.findFirst({ where: { id: counterpartyEmployeeId, businessId }, select: { nightShiftEligible: true } }),
  ]);
  if (newForA.pattern && newForA.pattern.isNightShift && !(empA && empA.nightShiftEligible)) {
    throw new SwapGuardError('SWAP_NIGHT_CONSENT', 'Requester has no night-shift consent for the swapped shift');
  }
  if (newForB.pattern && newForB.pattern.isNightShift && !(empB && empB.nightShiftEligible)) {
    throw new SwapGuardError('SWAP_NIGHT_CONSENT', 'Counterparty has no night-shift consent for the swapped shift');
  }

  // E5 — 11h inter-shift rest for BOTH employees against their adjacent days.
  const [restA, restB] = await Promise.all([
    restOkAfterPlacement(tx, businessId, requesterEmployeeId, requesterDate, newForA.pattern),
    restOkAfterPlacement(tx, businessId, counterpartyEmployeeId, counterpartyDate, newForB.pattern),
  ]);
  if (!restA || !restB) throw new SwapGuardError('SWAP_REST_VIOLATION', 'The swap breaks the 11-hour inter-shift rest');

  // I3 — atomic versioned swap. A lost race (the cell changed since we read it) → the
  // updateMany matches 0 rows → P2025-style guard → whole engine tx rolls back → 409.
  const flipA = await tx.rosterDay.updateMany({
    where: { id: cellA.id, version: cellA.version },
    data: {
      shiftPatternId: newForA.shiftPatternId, dayType: newForA.dayType,
      source: 'SWAP', swapRequestId: swap.id, version: { increment: 1 },
    },
  });
  const flipB = await tx.rosterDay.updateMany({
    where: { id: cellB.id, version: cellB.version },
    data: {
      shiftPatternId: newForB.shiftPatternId, dayType: newForB.dayType,
      source: 'SWAP', swapRequestId: swap.id, version: { increment: 1 },
    },
  });
  if (flipA.count === 0 || flipB.count === 0) {
    const err = new Error('Roster cell changed concurrently during swap');
    err.code = 'DECISION_RACE';
    throw err;
  }

  return [
    { employeeId: requesterEmployeeId, date: requesterDate },
    { employeeId: counterpartyEmployeeId, date: counterpartyDate },
  ];
}

// onApprove — PENDING → APPROVED. Guard consent, swap atomically, re-derive both days.
async function onApprove(approvalRequest, tx) {
  const swap = await loadSwap(tx, approvalRequest);
  if (!swap || swap.status !== 'PENDING') return; // already decided/withdrawn → no-op
  if (swap.counterpartyConsent !== 'ACCEPTED') {
    // The chain must never have opened without consent; fail-closed if it somehow did.
    throw new SwapGuardError('SWAP_NO_CONSENT', 'Counterparty has not accepted the swap');
  }

  const pairs = await applySwap(tx, swap);

  const flip = await tx.shiftSwapRequest.updateMany({
    where: { id: swap.id, status: 'PENDING' },
    data: { status: 'APPROVED', decidedBy: approvalRequest.decidedBy || null, decidedAt: new Date() },
  });
  if (flip.count === 0) {
    const err = new Error('Swap request already decided concurrently');
    err.code = 'DECISION_RACE';
    throw err;
  }

  // Re-derive BOTH affected (employee, day) pairs INSIDE the same tx so the daily
  // Attendance rollup reflects the swapped shift atomically with the approval.
  for (const p of pairs) {
    await recompute(swap.businessId, p.employeeId, utcDay(p.date), utcDay(p.date), tx);
  }

  // Notify both parties (fire-and-forget, OUTSIDE the engine tx via default prisma).
  notify.fanOutApprovalDecided({ businessId: approvalRequest.businessId, request: approvalRequest, outcome: 'APPROVED' }).catch(() => {});
}

// onReject — PENDING → REJECTED. Cells untouched.
async function onReject(approvalRequest, tx) {
  const swap = await loadSwap(tx, approvalRequest);
  if (!swap || swap.status !== 'PENDING') return;
  await tx.shiftSwapRequest.updateMany({
    where: { id: swap.id, status: 'PENDING' },
    data: { status: 'REJECTED', decidedBy: approvalRequest.decidedBy || null, decidedAt: new Date() },
  });
  notify.fanOutApprovalDecided({ businessId: approvalRequest.businessId, request: approvalRequest, outcome: 'REJECTED' }).catch(() => {});
}

// onCancel — requester withdrew → CANCELLED. Cells untouched.
async function onCancel(approvalRequest, tx) {
  const swap = await loadSwap(tx, approvalRequest);
  if (!swap || swap.status !== 'PENDING') return;
  await tx.shiftSwapRequest.updateMany({
    where: { id: swap.id, status: 'PENDING' },
    data: { status: 'CANCELLED', decidedBy: approvalRequest.decidedBy || null, decidedAt: new Date() },
  });
}

const bundle = { onApprove, onReject, onCancel };

function registerShiftSwapConsumer() {
  return consumers.register('SHIFT_SWAP', bundle);
}

// Self-register on module load (idempotent), mirroring consumers.leave.js / compOff.
registerShiftSwapConsumer();

module.exports = {
  registerShiftSwapConsumer,
  bundle,
  // exported for the controller's reuse + unit tests
  applySwap,
  SwapGuardError,
};
