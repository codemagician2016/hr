'use strict';

/**
 * payCalendar.controller.js — Program P1.1: the pay-calendar console backend.
 * The PayCalendar model (frequency / pay-day rule / cutoff rule) existed since
 * F15 but was SEED-ONLY — no route, no UI: a client could not configure their
 * own pay schedule. Tenant-scoped; canRunPayroll-gated at the route.
 *
 * Guard-rails:
 *  - IN entities are MONTHLY-only (the IN statutory engine annualises monthly);
 *    WEEKLY/FORTNIGHTLY/SEMI_MONTHLY unlock with the NZ path (P5 multi-country).
 *  - FIXED_DOM / N_DAYS_AFTER_PERIOD_END require a value (1..31 / 0..15).
 *  - Deactivate, never delete, once a PayRun references the calendar.
 */

const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');

const FREQUENCIES = ['WEEKLY', 'FORTNIGHTLY', 'SEMI_MONTHLY', 'MONTHLY'];
const DAY_RULES = ['LAST_WORKING_DAY', 'FIRST_WORKING_DAY', 'FIXED_DOM', 'N_DAYS_AFTER_PERIOD_END'];

function validateRule(prefix, rule, value) {
  if (!DAY_RULES.includes(rule)) return `${prefix}Rule must be one of ${DAY_RULES.join(', ')}`;
  if (rule === 'FIXED_DOM') {
    const v = Number(value);
    if (!Number.isInteger(v) || v < 1 || v > 31) return `${prefix}Value must be a day of month (1–31) for FIXED_DOM`;
  }
  if (rule === 'N_DAYS_AFTER_PERIOD_END') {
    const v = Number(value);
    if (!Number.isInteger(v) || v < 0 || v > 15) return `${prefix}Value must be 0–15 days for N_DAYS_AFTER_PERIOD_END`;
  }
  return null;
}

async function list(req, res, next) {
  try {
    const { businessId } = req.user;
    const items = await prisma.payCalendar.findMany({
      where: { businessId },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
      include: { entity: { select: { id: true, code: true, legalName: true, countryCode: true } } },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

async function create(req, res, next) {
  try {
    const { businessId } = req.user;
    const b = req.body || {};
    const entity = await prisma.entity.findFirst({ where: { id: b.entityId, businessId, deletedAt: null } });
    if (!entity) return res.status(404).json({ message: 'Entity not found' });
    const code = String(b.code || '').trim().toUpperCase();
    const name = String(b.name || '').trim();
    if (!code || !name) return res.status(400).json({ message: 'code and name are required' });
    if (!FREQUENCIES.includes(b.frequency)) return res.status(400).json({ message: `frequency must be one of ${FREQUENCIES.join(', ')}` });
    if (entity.countryCode === 'IN' && b.frequency !== 'MONTHLY') {
      return res.status(422).json({ message: 'India entities support MONTHLY pay frequency (weekly/fortnightly unlock with multi-country)' });
    }
    for (const [prefix, rule, value] of [['payDay', b.payDayRule, b.payDayValue], ['cutoffDay', b.cutoffDayRule, b.cutoffDayValue]]) {
      const err = validateRule(prefix, rule, value);
      if (err) return res.status(400).json({ message: err });
    }
    const row = await prisma.payCalendar.create({
      data: {
        businessId, entityId: entity.id, code, name,
        frequency: b.frequency,
        payDayRule: b.payDayRule, payDayValue: b.payDayValue != null && b.payDayValue !== '' ? Number(b.payDayValue) : null,
        cutoffDayRule: b.cutoffDayRule, cutoffDayValue: b.cutoffDayValue != null && b.cutoffDayValue !== '' ? Number(b.cutoffDayValue) : null,
        ...(b.prorationMethod ? { prorationMethod: b.prorationMethod } : {}),
      },
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'payroll.calendar.create', entityType: 'PayCalendar', entityId: row.id }).catch(() => {});
    res.status(201).json(row);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A calendar with that code already exists for this entity' });
    next(e);
  }
}

async function update(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.payCalendar.findFirst({
      where: { id: req.params.id, businessId },
      include: { entity: { select: { countryCode: true } } },
    });
    if (!existing) return res.status(404).json({ message: 'Pay calendar not found' });
    const b = req.body || {};
    const data = {};
    if (b.name !== undefined) {
      const name = String(b.name || '').trim();
      if (!name) return res.status(400).json({ message: 'name cannot be empty' });
      data.name = name;
    }
    if (b.frequency !== undefined) {
      if (!FREQUENCIES.includes(b.frequency)) return res.status(400).json({ message: `frequency must be one of ${FREQUENCIES.join(', ')}` });
      if (existing.entity.countryCode === 'IN' && b.frequency !== 'MONTHLY') {
        return res.status(422).json({ message: 'India entities support MONTHLY pay frequency' });
      }
      data.frequency = b.frequency;
    }
    for (const [field, prefix] of [['payDay', 'payDay'], ['cutoffDay', 'cutoffDay']]) {
      const rule = b[`${field}Rule`];
      const value = b[`${field}Value`];
      if (rule !== undefined) {
        const err = validateRule(prefix, rule, value !== undefined ? value : existing[`${field}Value`]);
        if (err) return res.status(400).json({ message: err });
        data[`${field}Rule`] = rule;
      }
      if (value !== undefined) data[`${field}Value`] = value == null || value === '' ? null : Number(value);
    }
    if (b.prorationMethod !== undefined) data.prorationMethod = b.prorationMethod;
    if (b.isActive !== undefined) data.isActive = b.isActive === true;
    const row = await prisma.payCalendar.update({
      where: { id: existing.id },
      data: { ...data, version: { increment: 1 } },
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'payroll.calendar.update', entityType: 'PayCalendar', entityId: row.id, meta: data }).catch(() => {});
    res.json(row);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A calendar with that code already exists for this entity' });
    next(e);
  }
}

async function deactivate(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.payCalendar.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Pay calendar not found' });
    const runCount = await prisma.payRun.count({ where: { businessId, payCalendarId: existing.id } });
    if (runCount > 0) {
      const row = await prisma.payCalendar.update({ where: { id: existing.id }, data: { isActive: false, version: { increment: 1 } } });
      await writeAudit({ businessId, actorId: req.user.id, action: 'payroll.calendar.deactivate', entityType: 'PayCalendar', entityId: row.id }).catch(() => {});
      return res.json({ deactivated: true, deleted: false, message: `${runCount} pay run(s) reference this calendar — deactivated, not deleted` });
    }
    await prisma.payCalendar.delete({ where: { id: existing.id } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'payroll.calendar.delete', entityType: 'PayCalendar', entityId: existing.id }).catch(() => {});
    res.json({ deactivated: false, deleted: true });
  } catch (e) { next(e); }
}

module.exports = { list, create, update, deactivate };
