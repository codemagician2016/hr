'use strict';

/**
 * leaveContext.js — DB-thin loader that assembles the {employee, shift,
 * holidays, policy, balance, overlapping} context the pure leave engines
 * (calendar.js / validators.js / policyResolver.js) need. Mirrors how
 * attendance/service.js resolves an employee's entity/location, shift pattern
 * and holiday calendar so leave and attendance agree on a working day.
 *
 * All math stays in the pure modules; this only reads.
 */

const prisma = require('../../core/lib/prisma');
const { resolveSchedule } = require('../attendance/derive');
const { resolvePolicy } = require('./policyResolver');
const { fyPeriodCode } = require('./periodCode');
// Feature 14 — single-country: the leave proration engine must consume ONLY the
// tenant-country holiday calendar. Without this an off-country Holiday row would
// feed leave debit/credit and downstream pay (invariant 1 + 6). Fail-closed:
// a tenant with no/ambiguous hrCountry throws (propagates to the caller's 409).
const { tenantCountry } = require('../tenant/countryContext');

function utcDay(d) {
  const x = d instanceof Date ? d : new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}
function addDays(d, n) { return new Date(utcDay(d).getTime() + n * 86400000); }

/**
 * loadApplyContext({ businessId, employeeId, leaveTypeId, startDate, endDate, asOf, tx })
 * Returns {
 *   employee,        // { id, businessId, gender, hireDate, employmentType, entityId, locationId, countryCode }
 *   leaveType,
 *   weeklyOffDays,   // CSV from the effective shift (null when open-attendance)
 *   holidays,        // [{ date, entityId, locationId, isRestricted, ... }]
 *   policy, accrualRules, assignment,   // from policyResolver (may be null)
 *   balance,         // LeaveBalance for the request's period (or null)
 *   periodCode,      // FY period the request falls in (drives the balance scope)
 *   overlapping,     // existing PENDING/APPROVED APPLICATION rows that may clash
 * }
 */
async function loadApplyContext({ businessId, employeeId, leaveTypeId, startDate, endDate, asOf, tx } = {}) {
  const db = tx || prisma;
  const from = utcDay(startDate);
  const to = utcDay(endDate);
  const winStart = from;
  const winEnd = addDays(to, 1);

  const empRow = await db.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: {
      id: true, businessId: true, gender: true, hireDate: true,
      countryCode: true, managerEmployeeId: true,
    },
  });
  if (!empRow) return { employee: null };

  // entity/location/department/grade/employmentType live on the CURRENT
  // EmploymentRecord (there are no such columns on Employee) — mirror
  // attendance/service.js. Used for holiday-scope matching + policy resolution.
  const employment = await db.employmentRecord.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    select: {
      entityId: true, locationId: true, departmentId: true, gradeId: true, employmentType: true,
      entity: { select: { taxYearStartMonth: true } },
    },
  });
  // Period for the request: derived from startDate using the entity's tax-year
  // start (Apr default) — the SAME scheme provision/accrualRunner mint balances
  // under. We scope the balance load to this period so soft-hold/validation
  // operate on the correct period's row, not the arbitrary newest one (finding #2).
  const taxYearStartMonth = (employment && employment.entity && employment.entity.taxYearStartMonth) || 4;
  const periodCode = fyPeriodCode(from, taxYearStartMonth);
  const employee = {
    ...empRow,
    entityId: employment ? employment.entityId : null,
    locationId: employment ? employment.locationId : null,
    departmentId: employment ? employment.departmentId : null,
    gradeId: employment ? employment.gradeId : null,
    employmentType: employment ? employment.employmentType : null,
  };

  const leaveType = await db.leaveType.findFirst({
    where: { id: leaveTypeId, businessId, deletedAt: null },
  });

  // F14 tripwire: pin the holiday read to the tenant country so the proration
  // engine can never consume an off-country row (import hole / bad backfill /
  // legacy data). Resolved once; fail-closed if the tenant country is unset.
  const holidayCountry = await tenantCountry(businessId);

  // Effective shift for the window's first day → its weeklyOffDays drive netting.
  const defaultPatternWhere = employee.entityId
    ? { OR: [{ entityId: employee.entityId }, { entityId: null }] }
    : { entityId: null };
  const [assignments, defaultPatterns, holidays, periodBalance, newestBalance, overlapping] = await Promise.all([
    db.shiftAssignment.findMany({
      where: { businessId, employeeId, effectiveFrom: { lt: winEnd } },
      include: { shiftPattern: true },
      orderBy: { effectiveFrom: 'desc' },
    }),
    db.shiftPattern.findMany({
      where: { businessId, deletedAt: null, isActive: true, ...defaultPatternWhere },
      orderBy: { createdAt: 'asc' },
    }),
    db.holiday.findMany({ where: { businessId, countryCode: holidayCountry, date: { gte: winStart, lte: winEnd } } }),
    // Period-scoped balance for the request's period (finding #2).
    db.leaveBalance.findFirst({
      where: { businessId, employeeId, leaveTypeId, periodCode },
    }),
    // Fallback only: legacy/anniversary-scheme rows that don't match the FY period
    // (so a single-period tenant still resolves a balance rather than null).
    db.leaveBalance.findFirst({
      where: { businessId, employeeId, leaveTypeId },
      orderBy: { createdAt: 'desc' },
    }),
    db.leaveTransaction.findMany({
      where: {
        businessId, employeeId, txnType: 'APPLICATION',
        status: { in: ['PENDING', 'APPROVED', 'AVAILED'] },
        startDate: { lte: winEnd }, endDate: { gte: winStart },
      },
      select: { id: true, startDate: true, endDate: true, status: true },
    }),
  ]);
  // Prefer the period-scoped row; fall back to the newest only when no row exists
  // for this period (never silently target a different period's balance).
  const balance = periodBalance || newestBalance;

  const defaultPattern = defaultPatterns.sort((a, b) => {
    const rank = (p) => (p.entityId === employee.entityId ? 1 : 0);
    return rank(b) - rank(a);
  })[0] || null;
  const schedule = resolveSchedule(from, (assignments || []).map((a) => ({
    effectiveFrom: a.effectiveFrom, effectiveTo: a.effectiveTo, shiftPattern: a.shiftPattern,
  })), defaultPattern);

  const resolved = leaveType
    ? await resolvePolicy(employee, leaveTypeId, asOf || new Date(), { tx: db })
    : null;

  // Feature 30 — when availing a COMP_OFF leave, load the employee's ACTIVE comp-off
  // lots so the validator can enforce the COMP_OFF_WOULD_BE_EXPIRED gate (you can't
  // avail a credit that lapses before the leave date). Cheap conditional read; null
  // for every other leave type so the leave engine is untouched.
  let compOffLots = null;
  if (leaveType && leaveType.category === 'COMP_OFF') {
    compOffLots = await db.compOffCredit.findMany({
      where: { businessId, employeeId, status: 'ACTIVE' },
      select: { id: true, quantity: true, consumed: true, earnedOn: true, expiresOn: true },
    });
  }

  return {
    employee,
    leaveType,
    weeklyOffDays: schedule ? schedule.weeklyOffDays : null,
    holidays,
    policy: resolved ? resolved.policy : null,
    accrualRules: resolved ? resolved.accrualRules : [],
    assignment: resolved ? resolved.assignment : null,
    balance,
    periodCode,
    overlapping,
    compOffLots,
  };
}

module.exports = { loadApplyContext, _internals: { utcDay, addDays } };
