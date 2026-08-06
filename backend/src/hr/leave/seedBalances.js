'use strict';

/**
 * seedBalances.js — give a newly-created employee their opening LeaveBalance rows.
 *
 * WHY THIS EXISTS
 * ───────────────────────────────────────────────────────────────────────────
 * A LeaveBalance row is the thing that makes leave possible at all. createRequest
 * refuses with 409 INSUFFICIENT_BALANCE ("No leave balance exists for this type")
 * when none is present, so an employee with no rows can never take a day off.
 *
 * Those rows used to be created in exactly two places — provision.js (an employee
 * provisioned from an onboarding journey) and the onboarding wizard. The ordinary
 * People → "Add employee" path created none. And nothing repaired it later:
 *
 *   • runNightlyAccrual iterates EXISTING LeaveBalance rows. It accrues onto them;
 *     it never creates one, so it cannot rescue an employee who has none.
 *   • Assigning a leave POLICY does not create balances either.
 *   • The only other route was a manual per-employee, per-type
 *     POST /leave/balances/adjust.
 *
 * So a client bulk-adding their existing staff through the obvious button ended up
 * with a workforce that could never apply for leave — permanently, with no
 * scheduled job that would ever fix it, and no signal until someone tried.
 *
 * The rows are all-zero (opening/accrued/taken/closing = 0), which grants nothing
 * on its own; it just opens the ledger so accrual and adjustments have somewhere
 * to land.
 */

// Fiscal-period code for a date, e.g. 2026-04-01 with startMonth 4 → "FY2026-27".
// Mirrors provision.js periodCodeFor so both paths land on the SAME period row.
function periodCodeFor(date, startMonth = 4) {
  const d = date ? new Date(date) : new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const startYear = m >= startMonth ? y : y - 1;
  return `FY${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * seedLeaveBalancesForEmployee(tx, { businessId, employeeId, countryCode, asOf, taxYearStartMonth })
 *   -> { created: number }
 *
 * Idempotent (upsert on the natural key). Never throws: a leave-ledger gap must
 * not fail the employee create that triggered it.
 */
async function seedLeaveBalancesForEmployee(tx, {
  businessId, employeeId, countryCode = null, asOf = new Date(), taxYearStartMonth = 4,
} = {}) {
  if (!tx || !businessId || !employeeId) return { created: 0 };
  try {
    const periodCode = periodCodeFor(asOf, taxYearStartMonth || 4);
    const leaveTypes = await tx.leaveType.findMany({
      where: {
        businessId, isActive: true, deletedAt: null,
        // A type with no country applies everywhere; a country-specific type only
        // to matching employees. Same rule provision.js uses.
        OR: [{ countryCode: null }, ...(countryCode ? [{ countryCode }] : [])],
      },
      select: { id: true, unit: true },
    });

    let created = 0;
    for (const lt of leaveTypes) {
      await tx.leaveBalance.upsert({
        where: {
          businessId_employeeId_leaveTypeId_periodCode: {
            businessId, employeeId, leaveTypeId: lt.id, periodCode,
          },
        },
        update: {},
        create: {
          businessId, employeeId, leaveTypeId: lt.id, periodCode,
          unit: lt.unit || 'DAYS',
          opening: '0.0000', accrued: '0.0000', taken: '0.0000', closing: '0.0000',
        },
      });
      created += 1;
    }
    return { created };
  } catch (e) {
    console.error(`[leave] could not seed leave balances for employee ${employeeId}: ${e.message}`);
    return { created: 0 };
  }
}

module.exports = { seedLeaveBalancesForEmployee, periodCodeFor };
