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
 * reCreditAllocations(allocations, lotsById, { asOf }) — the EXACT-lot reverse of a
 * persisted per-application allocation, used on WITHDRAW (findings #1 + #5). Unlike
 * reCreditToLots (which guessed lots reverse-FIFO), this returns units to the SAME
 * lots the leave debited — passed in as `allocations = [{ lotId, units }]` loaded from
 * the CompOffConsumption rows. A lot whose `expiresOn` is before `asOf` is FORFEITED:
 * its residual must never become spendable again (invariant 6), and — critically — the
 * forfeited units must NOT re-credit the aggregate balance either (finding #1), so the
 * caller subtracts `forfeited` from the closing/taken credit-back.
 *
 * Returns { moves:[{ lotId, give, newConsumed, reactivates }], forfeited } where
 * `give` is clamped to the lot's current consumed (never un-burns more than is there —
 * idempotent against a partially-reversed lot) and `reactivates` flags an EXHAUSTED lot
 * dropping back below quantity → ACTIVE.
 */
function reCreditAllocations(allocations, lotsById, { asOf = new Date() } = {}) {
  const now = utcDayMs(asOf);
  const moves = [];
  let forfeitedMilli = 0;
  for (const a of allocations || []) {
    const wantMilli = toThousandths(a.units);
    if (wantMilli <= 0) continue;
    const lot = lotsById instanceof Map ? lotsById.get(a.lotId) : (lotsById || {})[a.lotId];
    // Lot gone (deleted) or expired → forfeit these units (no lot re-credit, and the
    // caller drops them from the aggregate too).
    if (!lot || utcDayMs(lot.expiresOn) < now) { forfeitedMilli += wantMilli; continue; }
    const consumedMilli = toThousandths(lot.consumed);
    const giveMilli = Math.min(wantMilli, consumedMilli);
    if (giveMilli <= 0) { continue; } // already reversed on this lot → nothing to return
    const newConsumedMilli = consumedMilli - giveMilli;
    moves.push({
      lotId: lot.id,
      give: fromThousandths(giveMilli),
      newConsumed: fromThousandths(newConsumedMilli),
      // It dropped below quantity → spendable again. (It was EXHAUSTED iff it was full.)
      reactivates: newConsumedMilli < toThousandths(lot.quantity),
    });
  }
  return { moves, forfeited: fromThousandths(forfeitedMilli) };
}

/**
 * firstDayPastExpiry(activeLots, chargedDays) — per-day FIFO expiry check for the
 * COMP_OFF_WOULD_BE_EXPIRED gate (finding #4). `chargedDays = [{ date, fraction }]`
 * are the WORKING days this comp-off debits (fraction > 0), in any order. Walking the
 * days oldest-first and the lots FIFO (soonest-expiry first), it assigns each day's
 * fraction to lots and returns the FIRST day that lands AFTER the `expiresOn` of the
 * lot covering it (i.e. that day would spend a credit that has already lapsed). Returns
 * null when every charged day is on/before its covering lot's expiry. This catches a
 * multi-day span whose START is fine but whose LATER days fall past a lot's expiry —
 * which the START-only gate missed.
 */
function firstDayPastExpiry(activeLots, chargedDays) {
  const days = [...(chargedDays || [])]
    .filter((d) => d && Number(d.fraction) > 0)
    .sort((a, b) => utcDayMs(a.date) - utcDayMs(b.date));
  if (!days.length) return null;
  const lots = sortByExpiryAsc(activeLots).map((l) => ({
    expMs: utcDayMs(l.expiresOn),
    remMilli: Math.max(0, toThousandths(l.quantity) - toThousandths(l.consumed)),
  }));
  let li = 0;
  for (const day of days) {
    let needMilli = toThousandths(day.fraction);
    const dayMs = utcDayMs(day.date);
    while (needMilli > 0) {
      while (li < lots.length && lots[li].remMilli <= 0) li += 1;
      if (li >= lots.length) return null; // lots can't cover — the balance gate handles it
      const lot = lots[li];
      // The lot covering (part of) this day must not have expired before the day.
      if (lot.expMs < dayMs) return day.date;
      const takeMilli = Math.min(needMilli, lot.remMilli);
      lot.remMilli -= takeMilli;
      needMilli -= takeMilli;
    }
  }
  return null;
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
  reCreditAllocations,
  firstDayPastExpiry,
  lapseLots,
  sumActiveRemaining,
  earliestExpiryForUnits,
  remainingUnits,
  isExpired,
  sortByExpiryAsc,
  _internals: { utcDayMs },
};
