'use strict';

/**
 * restrictedHolidays.controller.js — Program P1.7: restricted/optional holiday
 * ELECTIONS. Holiday.isRestricted + the engine plumbing (optedRestrictedDates)
 * shipped in Feature 2 — but no store ever populated it, so restricted holidays
 * never actually counted. This adds the election store + surfaces:
 *
 *   ESS (customer session, SELF-ONLY):
 *     GET    /me/attendance/restricted-holidays          list + my elections + allowance
 *     POST   /me/attendance/restricted-holidays          { holidayId } elect
 *     DELETE /me/attendance/restricted-holidays/:holidayId  withdraw (future dates only)
 *
 *   Admin (canManageAttendance):
 *     GET    /attendance/rh-settings   { allowance }
 *     PATCH  /attendance/rh-settings   { allowance 0-30 }  (featureFlags.leave.restrictedHolidayAllowance)
 *
 * Elections are per CALENDAR YEAR; the allowance caps elections per year.
 * loadOptedRestrictedDates() is the shared read used by attendance recompute
 * and leaveContext.
 */

const prisma = require('../../core/lib/prisma');
const payrollService = require('../payroll/service');

const DEFAULT_ALLOWANCE = 2;

async function allowanceFor(businessId, db = prisma) {
  const biz = await db.business.findUnique({ where: { id: businessId }, select: { featureFlags: true } });
  const lf = biz && biz.featureFlags && typeof biz.featureFlags === 'object' ? biz.featureFlags.leave : null;
  const n = lf && Number.isInteger(lf.restrictedHolidayAllowance) ? lf.restrictedHolidayAllowance : DEFAULT_ALLOWANCE;
  return n;
}

/**
 * loadOptedRestrictedDates(db, { businessId, employeeId }) → Set<'YYYY-MM-DD'>
 * The employee's elected restricted-holiday DATES (all years — callers filter
 * by window naturally since they match against day keys).
 */
async function loadOptedRestrictedDates(db, { businessId, employeeId }) {
  const rows = await db.restrictedHolidayElection.findMany({
    where: { businessId, employeeId },
    select: { holidayId: true },
  });
  if (!rows.length) return new Set();
  const holidays = await db.holiday.findMany({
    where: { businessId, id: { in: rows.map((r) => r.holidayId) } },
    select: { date: true },
  });
  return new Set(holidays.map((h) => new Date(h.date).toISOString().slice(0, 10)));
}

// ── ESS (SELF-ONLY — subject comes from the session employee) ────────────────

async function selfEmployee(req, res) {
  const { businessId } = req.customer;
  const employeeId = await payrollService.resolveSelfEmployee(businessId, req.customer);
  if (!employeeId) {
    res.status(404).json({ message: 'No employee record is linked to your account' });
    return null;
  }
  const emp = await prisma.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true, currentEmploymentRecordId: true },
  });
  if (!emp) {
    res.status(404).json({ message: 'No employee record is linked to your account' });
    return null;
  }
  // Org context (entity/location) lives on the CURRENT EmploymentRecord, not
  // the Employee row — it scopes which restricted holidays apply.
  const rec = emp.currentEmploymentRecordId
    ? await prisma.employmentRecord.findFirst({
        where: { id: emp.currentEmploymentRecordId, businessId },
        select: { entityId: true, locationId: true },
      })
    : await prisma.employmentRecord.findFirst({
        where: { businessId, employeeId: emp.id, isCurrent: true },
        orderBy: { effectiveFrom: 'desc' },
        select: { entityId: true, locationId: true },
      });
  return {
    businessId,
    employee: { id: emp.id, entityId: rec ? rec.entityId : null, locationId: rec ? rec.locationId : null },
  };
}

async function listMine(req, res, next) {
  try {
    const ctx = await selfEmployee(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const from = new Date(Date.UTC(year, 0, 1));
    const to = new Date(Date.UTC(year, 11, 31));
    const [holidays, elections, allowance] = await Promise.all([
      prisma.holiday.findMany({
        where: {
          businessId, isRestricted: true, date: { gte: from, lte: to },
          AND: [
            { OR: [{ entityId: null }, { entityId: employee.entityId }] },
            { OR: [{ locationId: null }, { locationId: employee.locationId }] },
          ],
        },
        orderBy: { date: 'asc' },
        select: { id: true, name: true, date: true, type: true },
      }),
      prisma.restrictedHolidayElection.findMany({ where: { businessId, employeeId: employee.id, year } }),
      allowanceFor(businessId),
    ]);
    const electedIds = new Set(elections.map((e) => e.holidayId));
    return res.json({
      year,
      allowance,
      used: elections.length,
      items: holidays.map((h) => ({ ...h, elected: electedIds.has(h.id) })),
    });
  } catch (e) { return next(e); }
}

async function elect(req, res, next) {
  try {
    const ctx = await selfEmployee(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const holidayId = req.body && req.body.holidayId;
    if (!holidayId) return res.status(400).json({ message: 'holidayId is required' });
    const holiday = await prisma.holiday.findFirst({
      where: {
        id: holidayId, businessId, isRestricted: true,
        AND: [
          { OR: [{ entityId: null }, { entityId: employee.entityId }] },
          { OR: [{ locationId: null }, { locationId: employee.locationId }] },
        ],
      },
    });
    if (!holiday) return res.status(404).json({ message: 'Restricted holiday not found for your location' });
    const day = new Date(holiday.date);
    if (day < new Date(new Date().toISOString().slice(0, 10))) {
      return res.status(422).json({ message: 'This holiday has already passed — elections are for upcoming dates.' });
    }
    const year = day.getUTCFullYear();
    // Duplicate BEFORE quota — re-electing an already-elected holiday is a 409
    // whether or not the year's quota is exhausted (the P2002 catch below stays
    // as the race backstop).
    const dupe = await prisma.restrictedHolidayElection.findFirst({
      where: { businessId, employeeId: employee.id, holidayId },
      select: { id: true },
    });
    if (dupe) return res.status(409).json({ message: 'You have already elected this holiday.' });
    const [allowance, used] = await Promise.all([
      allowanceFor(businessId),
      prisma.restrictedHolidayElection.count({ where: { businessId, employeeId: employee.id, year } }),
    ]);
    if (used >= allowance) {
      return res.status(422).json({ message: `You have already elected ${used} of ${allowance} restricted holidays for ${year}.` });
    }
    try {
      const row = await prisma.restrictedHolidayElection.create({
        data: { businessId, employeeId: employee.id, holidayId, year },
      });
      return res.status(201).json({ id: row.id, holidayId, year, used: used + 1, allowance });
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ message: 'You have already elected this holiday.' });
      throw e;
    }
  } catch (e) { return next(e); }
}

async function withdraw(req, res, next) {
  try {
    const ctx = await selfEmployee(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const holidayId = req.params.holidayId;
    const existing = await prisma.restrictedHolidayElection.findFirst({
      where: { businessId, employeeId: employee.id, holidayId },
    });
    if (!existing) return res.status(404).json({ message: 'Election not found' });
    const holiday = await prisma.holiday.findFirst({ where: { id: holidayId, businessId }, select: { date: true } });
    if (holiday && new Date(holiday.date) < new Date(new Date().toISOString().slice(0, 10))) {
      return res.status(422).json({ message: 'This holiday has already passed — the election can no longer be withdrawn.' });
    }
    await prisma.restrictedHolidayElection.delete({ where: { id: existing.id } });
    return res.status(204).end();
  } catch (e) { return next(e); }
}

// ── Admin allowance setting ──────────────────────────────────────────────────

async function getSettings(req, res, next) {
  try {
    const { businessId } = req.user;
    return res.json({ allowance: await allowanceFor(businessId) });
  } catch (e) { return next(e); }
}

async function updateSettings(req, res, next) {
  try {
    const { businessId } = req.user;
    const allowance = req.body && req.body.allowance;
    if (!Number.isInteger(allowance) || allowance < 0 || allowance > 30) {
      return res.status(400).json({ message: 'allowance must be an integer between 0 and 30.' });
    }
    const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { featureFlags: true } });
    const flags = biz && biz.featureFlags && typeof biz.featureFlags === 'object' ? { ...biz.featureFlags } : {};
    flags.leave = { ...(flags.leave && typeof flags.leave === 'object' ? flags.leave : {}), restrictedHolidayAllowance: allowance };
    await prisma.business.update({ where: { id: businessId }, data: { featureFlags: flags } });
    return res.json({ allowance });
  } catch (e) { return next(e); }
}

module.exports = { listMine, elect, withdraw, getSettings, updateSettings, loadOptedRestrictedDates, allowanceFor };
