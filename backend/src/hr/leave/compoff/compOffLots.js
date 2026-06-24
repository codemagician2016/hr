'use strict';

/**
 * compOffLots.js — Comp-off per-credit lot math (Feature 30).
 *
 * PURE: no DB, no I/O, no prisma, no Date.now in the math. The caller (the
 * consumers.leave comp-off seam / the expiry runner / the controller) loads the
 * ACTIVE lots and passes them in; this module decides which lots to debit (FIFO
 * by expiry) and which to lapse. Same house style as `leave/accrual.js` /
 * `attendance/derive.js` — `node --test`-able to the unit.
 *
 * It reuses `ledger.js`'s integer-thousandths helpers so comp-off scales
 * IDENTICALLY to the rest of the leave vertical (no float drift on 0.5-day lots).
 *
 * The single correctness property mirrors the leave reconcile invariant:
 *   aggregate COMP_OFF LeaveBalance.closing == Σ (quantity − consumed) over ACTIVE lots
 * `remaining` is derived (quantity − consumed); never stored.
 */

const { toThousandths, fromThousandths } = require('../ledger');

function num(v, dflt = 0) {
  const n = v == null ? dflt : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function utcDayMs(d) {
  const x = d instanceof Date ? d : new Date(d);
  return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
}

/** remaining = quantity − consumed (in units, 4dp). The single source of truth. */
function remainingUnits(lot) {
  return fromThousandths(Math.max(0, toThousandths((lot || {}).quantity) - toThousandths((lot || {}).consumed)));
}

/**
 * sortByExpiryAsc(lots) — deterministic FIFO order: soonest-`expiresOn` first,
 * then oldest `earnedOn`, then `id`. Burning the soonest-to-expire credit first
 * MINIMISES lapse (edge case 6). Returns a new array (no mutation).
 */
function sortByExpiryAsc(lots) {
  return [...(lots || [])].sort((a, b) => {
    const ea = utcDayMs(a.expiresOn);
    const eb = utcDayMs(b.expiresOn);
    if (ea !== eb) return ea - eb;
    const oa = utcDayMs(a.earnedOn);
    const ob = utcDayMs(b.earnedOn);
    if (oa !== ob) return oa - ob;
    return String(a.id) < String(b.id) ? -1 : 1;
  });
}

/**
 * allocateFromLots(activeLots, units) — FIFO debit allocation (§4.3.1).
 *
 * Burns the soonest-to-expire ACTIVE lot first until `units` is satisfied.
 * Returns { allocations: [{ lotId, take, exhausts }], total } where `take` is the
 * units drawn from that lot and `exhausts` flags lots that become EXHAUSTED.
 * Throws INSUFFICIENT_COMP_OFF when the lots cannot cover `units` (this is the
 * belt to the aggregate `available()` gate the apply path already enforces).
 *
 * Thousandths-precise: never burns a fractional thousandth more than asked.
 */
function allocateFromLots(activeLots, units) {
  let remainingMilli = toThousandths(units);
  if (remainingMilli <= 0) return { allocations: [], total: 0 };
  const allocations = [];
  for (const lot of sortByExpiryAsc(activeLots)) {
    if (remainingMilli <= 0) break;
    const lotRemMilli = Math.max(0, toThousandths(lot.quantity) - toThousandths(lot.consumed));
    if (lotRemMilli <= 0) continue;
    const takeMilli = Math.min(remainingMilli, lotRemMilli);
    if (takeMilli <= 0) continue;
    const newConsumedMilli = toThousandths(lot.consumed) + takeMilli;
    allocations.push({
      lotId: lot.id,
      take: fromThousandths(takeMilli),
      newConsumed: fromThousandths(newConsumedMilli),
      exhausts: newConsumedMilli >= toThousandths(lot.quantity),
    });
    remainingMilli -= takeMilli;
  }
  if (remainingMilli > 0) {
    const err = new Error('Insufficient comp-off credit to cover the requested units');
    err.code = 'INSUFFICIENT_COMP_OFF';
    err.shortfall = fromThousandths(remainingMilli);
    throw err;
  }
  return { allocations, total: fromThousandths(toThousandths(units)) };
}

/**
 * reCreditToLots(lots, units, { asOf }) — the symmetric reverse of
 * allocateFromLots, used on WITHDRAW of an approved comp-off leave (edge case 8).
 * Returns the units back to the lots they came from in LIFO-of-consumption order
 * (un-burn the most-recently-burned first), but ONLY to lots not yet expired as of
 * `asOf` — an expired lot's residual must never become spendable again
 * (invariant 6). Returns { allocations:[{ lotId, give, newConsumed }], forfeited }
 * where `forfeited` is the units that could not be re-credited (all candidate lots
 * expired) and is dropped per the conservative `reinstateOnWithdraw=false` default.
 */
function reCreditToLots(lots, units, { asOf = new Date() } = {}) {
  let giveMilli = toThousandths(units);
  if (giveMilli <= 0) return { allocations: [], forfeited: 0 };
  const now = utcDayMs(asOf);
  // Re-credit the latest-expiring un-expired lots first (reverse of FIFO burn) so
  // we restore the lots that were drained last — keeping the soonest-to-expire lot
  // available for the next avail. Only un-expired lots are eligible.
  const eligible = sortByExpiryAsc(lots).filter((l) => utcDayMs(l.expiresOn) >= now).reverse();
  const allocations = [];
  for (const lot of eligible) {
    if (giveMilli <= 0) break;
    const consumedMilli = toThousandths(lot.consumed);
    if (consumedMilli <= 0) continue;
    const giveBackMilli = Math.min(giveMilli, consumedMilli);
    if (giveBackMilli <= 0) continue;
    allocations.push({
      lotId: lot.id,
      give: fromThousandths(giveBackMilli),
      newConsumed: fromThousandths(consumedMilli - giveBackMilli),
    });
    giveMilli -= giveBackMilli;
  }
  return { allocations, forfeited: fromThousandths(Math.max(0, giveMilli)) };
}

/**
 * isExpired(lot, asOf) — a lot whose `expiresOn` is strictly before the asOf civil
 * day. (A credit is usable through the END of its `expiresOn` day.)
 */
function isExpired(lot, asOf) {
  return utcDayMs((lot || {}).expiresOn) < utcDayMs(asOf);
}

/**
 * lapseLots(activeLots, asOf) — the expiry pass (§4.4). Returns the lots whose
 * `expiresOn` has passed with remaining > 0, each with its residual `lapsed`. The
 * caller posts a LAPSE LeaveTransaction + drops the aggregate closing + flips the
 * lot EXPIRED. Pure: the runner does the DB writes under a version lock.
 */
function lapseLots(activeLots, asOf = new Date()) {
  const out = [];
  let totalMilli = 0;
  for (const lot of activeLots || []) {
    if (!isExpired(lot, asOf)) continue;
    const remMilli = Math.max(0, toThousandths(lot.quantity) - toThousandths(lot.consumed));
    if (remMilli <= 0) continue;
    totalMilli += remMilli;
    out.push({ lotId: lot.id, lapsed: fromThousandths(remMilli) });
  }
  return { lots: out, total: fromThousandths(totalMilli) };
}

/**
 * sumActiveRemaining(lots) — Σ remaining over the given lots (units, 4dp). The
 * aggregate COMP_OFF LeaveBalance.closing must equal this (the comp-off reconcile
 * invariant 1).
 */
function sumActiveRemaining(lots) {
  let milli = 0;
  for (const lot of lots || []) {
    milli += Math.max(0, toThousandths(lot.quantity) - toThousandths(lot.consumed));
  }
  return fromThousandths(milli);
}

/**
 * earliestExpiryForUnits(activeLots, units) — walking the FIFO order, the
 * `expiresOn` of the LAST lot needed to cover `units`. This is the date by which
 * the requested comp-off must be taken; availing on a leave date AFTER it would
 * spend a credit that lapses first (reason COMP_OFF_WOULD_BE_EXPIRED, §4.3).
 * Returns null when the lots can't cover `units` (the balance gate catches that).
 */
function earliestExpiryForUnits(activeLots, units) {
  let remainingMilli = toThousandths(units);
  if (remainingMilli <= 0) return null;
  let last = null;
  for (const lot of sortByExpiryAsc(activeLots)) {
    const lotRemMilli = Math.max(0, toThousandths(lot.quantity) - toThousandths(lot.consumed));
    if (lotRemMilli <= 0) continue;
    last = lot.expiresOn;
    remainingMilli -= Math.min(remainingMilli, lotRemMilli);
    if (remainingMilli <= 0) return last;
  }
  return null; // can't cover — balance gate handles it
}

module.exports = {
  allocateFromLots,
  reCreditToLots,
  lapseLots,
  sumActiveRemaining,
  earliestExpiryForUnits,
  remainingUnits,
  isExpired,
  sortByExpiryAsc,
  _internals: { utcDayMs },
};
