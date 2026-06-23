'use strict';

/**
 * history.js — PURE presenters for the two layman-friendly leave views
 * (Feature 6 surfacing). No DB, no I/O, no prisma — the controllers load the
 * `LeaveTransaction` rows + `LeaveBalance` rows and pass them in; this module
 * shapes them into:
 *
 *   (A) a chronological HISTORY feed — every request decision AND every ledger
 *       movement, each tagged with a plain-English label, a signed `delta`
 *       (+credit / −debit / 0 informational) and a `direction` for colour.
 *   (B) a RECONCILIATION statement per (leave type, period) that visibly
 *       BALANCES: opening + accrued − taken − encashed − lapsed + adjusted =
 *       closing, computed from the ledger and cross-checked against the
 *       persisted `LeaveBalance` so any drift is flagged.
 *
 * Unit-testable with plain `node`, the house style of ledger.js / accrual.js.
 * Reuses ledger.js for the signed-quantity arithmetic so the whole vertical
 * agrees to the thousandth.
 */

const ledger = require('./ledger');

const { fromThousandths, toThousandths } = ledger;

function num(v, dflt = 0) {
  const n = v == null ? dflt : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// ── plain-English movement labels ────────────────────────────────────────────
// Every history row carries a label a non-technical employee understands, plus a
// `direction` ('credit' | 'debit' | 'none') the UI colours green / red / grey.

function movementLabel(txn) {
  const t = txn || {};
  switch (t.txnType) {
    case 'OPENING_BALANCE':
      return 'Opening balance carried in';
    case 'ACCRUAL':
      return 'Leave earned (accrued)';
    case 'ENCASHMENT':
      return 'Leave encashed (paid out)';
    case 'LAPSE':
      return 'Leave lapsed (expired unused)';
    case 'ADJUSTMENT':
      return num(t.quantity) >= 0 ? 'Manual credit (adjustment)' : 'Manual debit (adjustment)';
    case 'CANCELLATION':
      return 'Approved leave withdrawn (credited back)';
    case 'APPLICATION': {
      switch (t.status) {
        case 'PENDING': return 'Leave requested (awaiting approval)';
        case 'APPROVED':
        case 'AVAILED': return 'Leave taken (approved)';
        case 'REJECTED': return 'Leave request rejected';
        case 'CANCELLED': return 'Leave request withdrawn';
        case 'WITHDRAWN': return 'Approved leave withdrawn';
        default: return 'Leave requested';
      }
    }
    default:
      return 'Leave movement';
  }
}

// The signed effect of a row on the running balance, in units (reuses the audited
// ledger reducer so APPLICATION only counts when APPROVED/AVAILED, etc.).
function deltaOf(txn) {
  return ledger.signedQuantity(txn);
}

function directionOf(delta) {
  if (delta > 0) return 'credit';
  if (delta < 0) return 'debit';
  return 'none';
}

function isoDate(d) {
  if (!d) return null;
  const s = typeof d === 'string' ? d : new Date(d).toISOString();
  return s.slice(0, 10);
}

/**
 * buildHistory(txns, { withRunningBalance }) — a chronological, layman-friendly
 * feed from the raw ledger rows. Sorted oldest→newest by the row's effective
 * date (appliedAt ?? createdAt), each entry carries:
 *   { id, txnType, status, label, direction, delta, quantity, balanceAfter?,
 *     leaveType{...}, startDate, endDate, reason, appliedAt, decidedAt, createdAt }
 * When `withRunningBalance` is true a `balanceAfter` running tally is attached
 * (the sum of every signed delta up to and including the row), so the employee
 * can read their balance forward in time.
 */
function buildHistory(txns, { withRunningBalance = true } = {}) {
  const rows = (txns || []).slice().sort((a, b) => {
    const ka = new Date(a.appliedAt || a.createdAt || 0).getTime();
    const kb = new Date(b.appliedAt || b.createdAt || 0).getTime();
    if (ka !== kb) return ka - kb;
    // stable tie-break on id so equal-timestamp rows order deterministically
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  let runningMilli = 0;
  return rows.map((r) => {
    const delta = deltaOf(r);
    let balanceAfter;
    if (withRunningBalance) {
      runningMilli += toThousandths(delta);
      balanceAfter = fromThousandths(runningMilli);
    }
    const lt = r.leaveType || null;
    return {
      id: r.id,
      txnType: r.txnType,
      status: r.status,
      label: movementLabel(r),
      direction: directionOf(delta),
      delta,
      quantity: num(r.quantity),
      unit: r.unit || (lt && lt.unit) || 'DAYS',
      ...(withRunningBalance ? { balanceAfter } : {}),
      leaveType: lt
        ? { id: lt.id, code: lt.code, name: lt.name, color: lt.color || null, unit: lt.unit || null }
        : null,
      leaveTypeId: r.leaveTypeId || (lt && lt.id) || null,
      startDate: isoDate(r.startDate),
      endDate: isoDate(r.endDate),
      reason: r.reason || null,
      appliedAt: r.appliedAt || null,
      decidedAt: r.decidedAt || null,
      decidedBy: r.decidedBy || null,
      createdAt: r.createdAt || null,
    };
  });
}

// ── (B) reconciliation statement ──────────────────────────────────────────────

/**
 * reconcileBuckets(txns, persistedBalance) — the reconciliation for ONE
 * (leaveType, period) lot. Recomputes every bucket from the ledger via
 * ledger.reconstructBuckets, lays out the closing identity as ordered line items
 * that BALANCE, and cross-checks the ledger closing against the persisted
 * `LeaveBalance.closing` (flags drift).
 *
 * Returns:
 *   {
 *     opening, accrued, taken, encashed, lapsed, adjusted, pendingApproval,
 *     closing,                       // computed from the ledger (the truth)
 *     persistedClosing,              // LeaveBalance.closing (null if no row)
 *     drift,                         // computed − persisted (0 when reconciled)
 *     reconciled,                    // |drift| within tolerance
 *     available,                     // closing − pendingApproval
 *     lines: [ { key, label, sign, value, kind } … = closing ],
 *   }
 * `lines` is an ordered, sign-tagged breakdown the UI renders verbatim; the
 * arithmetic on `lines` provably sums to `closing`.
 */
function reconcileBuckets(txns, persistedBalance, { tolerance = 0.0001 } = {}) {
  const b = ledger.reconstructBuckets(txns || []);
  const persistedClosing = persistedBalance && persistedBalance.closing != null
    ? num(persistedBalance.closing)
    : null;
  const drift = persistedClosing == null
    ? 0
    : fromThousandths(toThousandths(b.closing) - toThousandths(persistedClosing));
  const reconciled = persistedClosing == null ? true : Math.abs(drift) <= tolerance;
  const available = fromThousandths(toThousandths(b.closing) - toThousandths(b.pendingApproval));

  // ordered line items — the visible arithmetic. sign drives + / − rendering and
  // colour; the reducer over (sign × value) re-derives `closing` exactly.
  const lines = [
    { key: 'opening', label: 'You started the period with', sign: 1, value: b.opening, kind: 'opening' },
    { key: 'accrued', label: 'Leave you earned (accrued)', sign: 1, value: b.accrued, kind: 'credit' },
    { key: 'taken', label: 'Leave you took (approved)', sign: -1, value: b.taken, kind: 'debit' },
    { key: 'encashed', label: 'Leave paid out (encashed)', sign: -1, value: b.encashed, kind: 'debit' },
    { key: 'lapsed', label: 'Leave that lapsed (expired)', sign: -1, value: b.lapsed, kind: 'debit' },
    { key: 'adjusted', label: b.adjusted >= 0 ? 'Manual credits (adjustments)' : 'Manual debits (adjustments)', sign: 1, value: b.adjusted, kind: b.adjusted >= 0 ? 'credit' : 'debit' },
  ];

  return {
    opening: b.opening,
    accrued: b.accrued,
    taken: b.taken,
    encashed: b.encashed,
    lapsed: b.lapsed,
    adjusted: b.adjusted,
    pendingApproval: b.pendingApproval,
    closing: b.closing,
    persistedClosing,
    drift,
    reconciled,
    available,
    lines,
  };
}

/**
 * groupReconciliation(txns, balances, leaveTypeById) — split a flat ledger into
 * one reconciliation lot per (leaveTypeId). The caller scopes `txns` /
 * `balances` to a single period before calling (or passes a single period's
 * rows), so each group is a clean (employee, leaveType, period) statement.
 *
 * `balances` is the matching persisted-balance array; we index it by leaveTypeId
 * to cross-check each lot. `leaveTypeById` (optional Map) decorates each group
 * with the type's name/colour for the UI.
 */
function groupReconciliation(txns, balances, leaveTypeById) {
  const byType = new Map();
  for (const t of txns || []) {
    const k = t.leaveTypeId || (t.leaveType && t.leaveType.id);
    if (!k) continue;
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k).push(t);
  }
  // include leave types that have a persisted balance but no ledger rows yet
  const balByType = new Map();
  for (const bal of balances || []) {
    if (bal.leaveTypeId) balByType.set(bal.leaveTypeId, bal);
    if (!byType.has(bal.leaveTypeId)) byType.set(bal.leaveTypeId, []);
  }

  const groups = [];
  for (const [leaveTypeId, rows] of byType) {
    const persisted = balByType.get(leaveTypeId) || null;
    const lt = (leaveTypeById && leaveTypeById.get(leaveTypeId))
      || (rows[0] && rows[0].leaveType)
      || (persisted && persisted.leaveType)
      || null;
    const recon = reconcileBuckets(rows, persisted);
    groups.push({
      leaveTypeId,
      leaveType: lt
        ? { id: lt.id, code: lt.code, name: lt.name, color: lt.color || null, unit: lt.unit || null }
        : null,
      unit: (lt && lt.unit) || (persisted && persisted.unit) || (rows[0] && rows[0].unit) || 'DAYS',
      ...recon,
    });
  }
  // stable order: by leave-type name then id
  groups.sort((a, b) => {
    const na = (a.leaveType && a.leaveType.name) || '';
    const nb = (b.leaveType && b.leaveType.name) || '';
    return na.localeCompare(nb) || String(a.leaveTypeId).localeCompare(String(b.leaveTypeId));
  });
  return groups;
}

module.exports = {
  buildHistory,
  reconcileBuckets,
  groupReconciliation,
  movementLabel,
  _internals: { deltaOf, directionOf },
};
