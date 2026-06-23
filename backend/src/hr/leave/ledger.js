'use strict';

/**
 * ledger.js — Leave balance ledger core (Feature 6).
 *
 * PURE: no DB, no I/O, no prisma. Unit-testable with plain `node`, the house
 * style of `attendance/derive.js` and `payroll/compliance/holidaysAct.js`.
 *
 * `LeaveBalance` is a PERSISTED PROJECTION of the append-only `LeaveTransaction`
 * ledger. The persisted `closing` exists for fast ESS reads but MUST always
 * equal the signed reduction over the ledger. That equality is this module's
 * single correctness property (docs/features/06 §4.2).
 *
 * Closing identity (must hold after every transaction):
 *   closing = opening + accrued − taken − encashed − lapsed + adjusted
 * Carried-in units live in `opening`; there is NO separate `carryForward` bucket
 * (schema has no such column — §9 correction 1).
 *
 * Available-to-apply (what the apply flow checks):
 *   available = closing − pendingApproval + (allowNegative ? negativeCap : 0)
 *
 * Precision: hold day/week math as integer THOUSANDTHS (×1000) internally to
 * avoid 1/12-accrual float drift; round to the policy grain at the boundary.
 * Persisted columns are Decimal(10,4); we round to 4 dp on the way out.
 */

// ── scaling helpers (integer-thousandths discipline) ─────────────────────────
const SCALE = 1000;

function num(v, dflt = 0) {
  const n = v == null ? dflt : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Units (a Decimal-ish number/string) → integer thousandths. */
function toThousandths(units) {
  return Math.round(num(units) * SCALE);
}

/** Integer thousandths → a Number rounded to 4 dp (Decimal(10,4) grain). */
function fromThousandths(milli) {
  return Math.round((milli / SCALE) * 1e4) / 1e4;
}

/** Round a unit figure to a policy grain (e.g. 0.5 days), half-up. A grain
 *  finer than one thousandth (e.g. NZ 4/52-week ticks) falls through to the
 *  thousandths grain rather than dividing by zero. */
function roundToGrain(units, grain = 0.5) {
  if (!grain || grain <= 0) return fromThousandths(toThousandths(units));
  const g = toThousandths(grain);
  const m = toThousandths(units);
  if (g <= 0) return fromThousandths(m); // sub-thousandth grain → thousandths grain
  return fromThousandths(Math.round(m / g) * g);
}

// ── closing identity ─────────────────────────────────────────────────────────

/**
 * computeClosing(buckets) — the persisted `closing` from the buckets.
 *   closing = opening + accrued − taken − encashed − lapsed + adjusted
 * `pendingApproval` is a SOFT-HOLD and is NOT part of closing.
 */
function computeClosing(buckets) {
  const b = buckets || {};
  const milli =
    toThousandths(b.opening) +
    toThousandths(b.accrued) -
    toThousandths(b.taken) -
    toThousandths(b.encashed) -
    toThousandths(b.lapsed) +
    toThousandths(b.adjusted);
  return fromThousandths(milli);
}

/**
 * available(balance, policy) — units an employee may still apply for.
 *   available = closing − pendingApproval + (allowNegative ? negativeCap : 0)
 */
function available(balance, policy) {
  const b = balance || {};
  const p = policy || {};
  let milli = toThousandths(b.closing) - toThousandths(b.pendingApproval);
  if (p.allowNegative) milli += toThousandths(p.negativeCap);
  return fromThousandths(milli);
}

// ── ledger reconstruction (the audited invariant) ────────────────────────────

/**
 * signedQuantity(txn) — the contribution of one ledger row to `closing`.
 *   OPENING_BALANCE → +q
 *   ACCRUAL         → +q
 *   APPLICATION     → −|q|   (only when status ∈ {APPROVED, AVAILED})
 *   ENCASHMENT      → −|q|
 *   LAPSE           → −|q|
 *   ADJUSTMENT      → ±q     (signed, as stored)
 *   CANCELLATION    → 0      (a withdrawn application reverses via ADJUSTMENT)
 * Anything else / a non-consuming application status → 0.
 * Returned in integer thousandths.
 */
function signedQuantityMilli(txn) {
  const t = txn || {};
  const q = toThousandths(t.quantity);
  const abs = Math.abs(q);
  switch (t.txnType) {
    case 'OPENING_BALANCE':
    case 'ACCRUAL':
      return abs; // grants are always positive regardless of stored sign
    case 'ENCASHMENT':
    case 'LAPSE':
      return -abs;
    case 'APPLICATION':
      return t.status === 'APPROVED' || t.status === 'AVAILED' ? -abs : 0;
    case 'ADJUSTMENT':
      return q; // signed
    case 'CANCELLATION':
    default:
      return 0;
  }
}

/** Public form (units, not thousandths). */
function signedQuantity(txn) {
  return fromThousandths(signedQuantityMilli(txn));
}

/**
 * reconstructClosing(txns) — recompute `closing` purely from the ledger.
 * This is what `leave.reconcile.test.js` asserts equals the persisted column.
 */
function reconstructClosing(txns) {
  let milli = 0;
  for (const t of txns || []) milli += signedQuantityMilli(t);
  return fromThousandths(milli);
}

/**
 * reconstructBuckets(txns) — recompute every bucket from the ledger, so a
 * persisted LeaveBalance can be audited field-by-field, not just on `closing`.
 * `pendingApproval` = Σ |APPLICATION.quantity| over PENDING rows (soft-hold).
 */
function reconstructBuckets(txns) {
  let opening = 0; let accrued = 0; let taken = 0; let encashed = 0;
  let lapsed = 0; let adjusted = 0; let pending = 0;
  for (const t of txns || []) {
    const q = toThousandths(t.quantity);
    const abs = Math.abs(q);
    switch (t.txnType) {
      case 'OPENING_BALANCE': opening += abs; break;
      case 'ACCRUAL': accrued += abs; break;
      case 'ENCASHMENT': encashed += abs; break;
      case 'LAPSE': lapsed += abs; break;
      case 'ADJUSTMENT': adjusted += q; break;
      case 'APPLICATION':
        if (t.status === 'APPROVED' || t.status === 'AVAILED') taken += abs;
        else if (t.status === 'PENDING') pending += abs;
        break;
      default: break;
    }
  }
  const buckets = {
    opening: fromThousandths(opening),
    accrued: fromThousandths(accrued),
    taken: fromThousandths(taken),
    encashed: fromThousandths(encashed),
    lapsed: fromThousandths(lapsed),
    adjusted: fromThousandths(adjusted),
    pendingApproval: fromThousandths(pending),
  };
  buckets.closing = computeClosing(buckets);
  return buckets;
}

/**
 * reconciles(balance, txns, { tolerance }) — true when the persisted balance
 * agrees with the ledger on `closing` (within a 1-thousandth tolerance for the
 * Decimal rounding). The reconcile test uses this as its assertion.
 */
function reconciles(balance, txns, { tolerance = 0.0001 } = {}) {
  const fromLedger = reconstructClosing(txns);
  const persisted = num((balance || {}).closing);
  return Math.abs(fromLedger - persisted) <= tolerance;
}

module.exports = {
  computeClosing,
  available,
  signedQuantity,
  reconstructClosing,
  reconstructBuckets,
  reconciles,
  // precision helpers reused by accrual.js so the whole vertical scales the same way
  toThousandths,
  fromThousandths,
  roundToGrain,
  _internals: { signedQuantityMilli, SCALE },
};
