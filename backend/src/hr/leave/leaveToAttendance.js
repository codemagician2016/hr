'use strict';

/**
 * leaveToAttendance.js — Feature 16, the leave→attendance EAGER bridge (PURE).
 *
 * When a leave application is APPROVED we must reliably stamp `Attendance`
 * `ON_LEAVE` rows for its working days, so an approved LWP day becomes a
 * frozen-eligible LOP day EVEN IF the nightly derivation never runs for that
 * employee (today the leave→attendance bridge only fires during the nightly
 * derive/recompute; an approval must eagerly materialise the days — closing the
 * "approval before derive" race). The nightly `recompute` remains the reconciler:
 * it re-derives the SAME rows deterministically (idempotent upsert → no drift).
 *
 * PURE: no DB, no I/O. It REUSES `calendar.computeLeaveUnits` (the exact
 * working-day + sandwich netting the apply path already used) so the materialised
 * days agree, byte-for-byte, with what was charged. The thin DB writer that turns
 * this into `upsert`s (where isLocked=false) lives in the leave consumer/controller,
 * inside the approve transaction.
 *
 *   materialiseLeaveDays(txn, ctx) -> [{ date:'YYYY-MM-DD', status:'ON_LEAVE',
 *                                        lopFraction, source:'LEAVE_APPROVAL' }]
 *
 * Semantics (docs/features/16 §4.3 + §7.3):
 *   - For each working-day breakdown row with fraction > 0:
 *       lopFraction = ctx.leaveType.affectsLOP ? fraction : 0
 *       (LWP/UNPAID → the netted fraction is LOP; a PAID leave → 0, so the day is
 *        ON_LEAVE-but-paid and contributes paidLeaveDays, not lopDays).
 *   - Weekoff / holiday days (fraction 0) are NOT emitted → they stay PAYABLE
 *     (a public holiday inside an LWP block is paid as a holiday — LWP is
 *     sandwichPolicy=EXCLUSIVE so it never converts a holiday into an unpaid day).
 *   - A half-day boundary (fraction 0.5) emits lopFraction 0.5 for an LWP day —
 *     so "0.5 paid SL + 0.5 LWP" materialises ONLY the LWP half as LOP.
 */

const { computeLeaveUnits } = require('./calendar');
const { loadApplyContext } = require('./leaveContext');

function utcDateOnly(d) {
  const s = isoDay(d);
  return new Date(`${s}T00:00:00.000Z`);
}

function isoDay(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  const x = d instanceof Date ? d : new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()))
    .toISOString().slice(0, 10);
}

/**
 * materialiseLeaveDays(txn, ctx)
 *   txn = { startDate, endDate, startHalf?, endHalf? }   (the APPLICATION row)
 *   ctx = {
 *     employee,        // { entityId, locationId, countryCode }
 *     leaveType,       // { affectsLOP, countryCode, sandwichPolicy? }
 *     weeklyOffDays,   // CSV/array ISO weekday from the effective shift
 *     holidays,        // [{ date, entityId, locationId, isRestricted, ... }]
 *     optedRestrictedDates?,
 *   }
 * Returns the ON_LEAVE day rows to upsert (working days only). PURE.
 */
function materialiseLeaveDays(txn, ctx = {}) {
  if (!txn || !txn.startDate || !txn.endDate) return [];
  const leaveType = ctx.leaveType || {};
  const affectsLOP = leaveType.affectsLOP === true;

  const netted = computeLeaveUnits(
    {
      startDate: isoDay(txn.startDate),
      endDate: isoDay(txn.endDate),
      startHalf: txn.startHalf || null,
      endHalf: txn.endHalf || null,
    },
    {
      employee: ctx.employee || {},
      leaveType,
      weeklyOffDays: ctx.weeklyOffDays,
      holidays: ctx.holidays,
      optedRestrictedDates: ctx.optedRestrictedDates,
    },
  );

  const out = [];
  for (const d of netted.dayBreakdown || []) {
    // Only ACTUAL leave days (working-day fractions). Weekoff/holiday rows the
    // sandwich netting left at fraction 0 are skipped → they stay payable.
    if (!(d.fraction > 0)) continue;
    // A sandwiched holiday/weekoff that WAS debited (INCLUSIVE) carries the
    // *_DEBITED kind; for LWP we set sandwich EXCLUSIVE so those never appear, but
    // guard anyway — never turn a holiday into an unpaid attendance row.
    if (d.kind === 'HOLIDAY_DEBITED' || d.kind === 'WEEKOFF_DEBITED') continue;
    out.push({
      date: d.date,
      status: 'ON_LEAVE',
      lopFraction: affectsLOP ? d.fraction : 0,
      source: 'LEAVE_APPROVAL',
    });
  }
  return out;
}

/**
 * stampLeaveAttendanceOnApproval(db, txn) — the thin DB writer (Feature 16 §4.3).
 *
 * Called INSIDE the approve transaction (from the LEAVE consumer's APPROVED
 * transition) so the ON_LEAVE rows commit atomically with the approval. Loads the
 * SAME context the apply path used (working days / holidays / sandwich), runs the
 * PURE `materialiseLeaveDays`, then upserts one `Attendance` row per emitted day:
 *
 *   - IDEMPOTENT: upsert on @@unique([businessId,employeeId,date]); a re-approve /
 *     nightly recompute writes the identical row → no drift.
 *   - MONOTONIC: never overwrite an `isLocked=true` row (a day already frozen into a
 *     CLOSED/PAID run stays frozen). Such retro days are reported as
 *     RETRO_LWP_DEFERRED so the effect can settle in the next open period.
 *   - SAFE FOR PAID LEAVE TOO: a paid leave materialises ON_LEAVE rows with
 *     lopFraction 0 (so it is visible on the attendance grid and contributes
 *     paidLeaveDays, never lopDays) — it CANNOT cause LOP.
 *
 * Returns { stamped, deferred:[{date}], days:[…] }. NEVER throws on a stamp miss;
 * a malformed/holiday-only span simply stamps nothing.
 *
 * @param {object} db   a Prisma client OR transaction client (the caller's tx)
 * @param {object} txn  the APPROVED LeaveTransaction APPLICATION row
 */
async function stampLeaveAttendanceOnApproval(db, txn) {
  if (!txn || txn.txnType !== 'APPLICATION') return { stamped: 0, deferred: [], days: [] };
  const ctx = await loadApplyContext({
    businessId: txn.businessId,
    employeeId: txn.employeeId,
    leaveTypeId: txn.leaveTypeId,
    startDate: txn.startDate,
    endDate: txn.endDate,
    asOf: new Date(),
    tx: db,
  });
  if (!ctx.employee || !ctx.leaveType) return { stamped: 0, deferred: [], days: [] };

  const days = materialiseLeaveDays(
    { startDate: txn.startDate, endDate: txn.endDate, startHalf: txn.startHalf, endHalf: txn.endHalf },
    ctx,
  );
  if (!days.length) return { stamped: 0, deferred: [], days: [] };

  let stamped = 0;
  const deferred = [];
  for (const d of days) {
    const date = utcDateOnly(d.date);
    // Monotonic guard: a frozen (locked) day must not retro-mutate. Read first.
    const existing = await db.attendance.findUnique({
      where: { businessId_employeeId_date: { businessId: txn.businessId, employeeId: txn.employeeId, date } },
      select: { id: true, isLocked: true },
    });
    if (existing && existing.isLocked) {
      deferred.push({ date: d.date }); // RETRO_LWP_DEFERRED — settles next open period
      continue;
    }
    const exJson = { source: d.source, leaveTxnId: txn.id, materialisedAt: new Date().toISOString() };
    if (existing) {
      await db.attendance.update({
        where: { id: existing.id },
        data: { status: d.status, lopFraction: d.lopFraction, exceptionsJson: exJson },
      });
    } else {
      await db.attendance.create({
        data: {
          businessId: txn.businessId,
          employeeId: txn.employeeId,
          date,
          status: d.status,
          lopFraction: d.lopFraction,
          isLocked: false,
          exceptionsJson: exJson,
        },
      });
    }
    stamped += 1;
  }
  return { stamped, deferred, days };
}

module.exports = {
  materialiseLeaveDays,
  stampLeaveAttendanceOnApproval,
  _internals: { isoDay, utcDateOnly },
};
