'use strict';

/**
 * workPolicies.controller.js — Program P1.5: OT + late-coming policy consoles.
 * OvertimeRule existed since Cycle-0 but had NO write endpoint or UI (defaults
 * were schema-baked); LateComingRule is new (the India-common "N lates allowed,
 * then every M further lates costs a fraction of a day"). Both entity/location
 * scoped, most-specific active rule wins. canManageAttendance-gated at routes.
 */

const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');

async function validateScope(businessId, b, res) {
  if (b.entityId) {
    const ent = await prisma.entity.findFirst({ where: { id: b.entityId, businessId, deletedAt: null }, select: { id: true } });
    if (!ent) { res.status(404).json({ message: 'entity not found in this tenant' }); return false; }
  }
  if (b.locationId) {
    const loc = await prisma.location.findFirst({ where: { id: b.locationId, businessId }, select: { id: true } });
    if (!loc) { res.status(404).json({ message: 'location not found in this tenant' }); return false; }
  }
  return true;
}

// ── Overtime rules ────────────────────────────────────────────────────────────

const OT_FIELDS = ['dailyThresholdMin', 'dailyCapMin', 'roundingMin'];
const OT_MULTIPLIERS = ['weekdayMultiplier', 'weeklyOffMultiplier', 'holidayMultiplier'];

function pickOtData(b) {
  const data = {};
  for (const f of OT_FIELDS) {
    if (b[f] !== undefined) {
      const v = b[f] == null || b[f] === '' ? null : Number(b[f]);
      if (v != null && (!Number.isInteger(v) || v < 0 || v > 1440)) return { error: `${f} must be minutes (0–1440)` };
      if (f !== 'dailyCapMin' && v == null) return { error: `${f} is required` };
      data[f] = v;
    }
  }
  for (const f of OT_MULTIPLIERS) {
    if (b[f] !== undefined) {
      const v = Number(b[f]);
      if (!Number.isFinite(v) || v < 0 || v > 10) return { error: `${f} must be a multiplier between 0 and 10` };
      data[f] = v;
    }
  }
  if (b.isActive !== undefined) data.isActive = b.isActive === true;
  return { data };
}

async function listOtRules(req, res, next) {
  try {
    const { businessId } = req.user;
    const items = await prisma.overtimeRule.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } });
    res.json({ items });
  } catch (e) { next(e); }
}

async function createOtRule(req, res, next) {
  try {
    const { businessId } = req.user;
    const b = req.body || {};
    if (!(await validateScope(businessId, b, res))) return;
    const { data, error } = pickOtData(b);
    if (error) return res.status(400).json({ message: error });
    const row = await prisma.overtimeRule.create({
      data: { businessId, entityId: b.entityId || null, locationId: b.locationId || null, ...data },
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'attendance.otRule.create', entityType: 'OvertimeRule', entityId: row.id }).catch(() => {});
    res.status(201).json(row);
  } catch (e) { next(e); }
}

async function updateOtRule(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.overtimeRule.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Overtime rule not found' });
    const { data, error } = pickOtData(req.body || {});
    if (error) return res.status(400).json({ message: error });
    const row = await prisma.overtimeRule.update({ where: { id: existing.id }, data });
    await writeAudit({ businessId, actorId: req.user.id, action: 'attendance.otRule.update', entityType: 'OvertimeRule', entityId: row.id, meta: data }).catch(() => {});
    res.json(row);
  } catch (e) { next(e); }
}

async function deleteOtRule(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.overtimeRule.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Overtime rule not found' });
    await prisma.overtimeRule.delete({ where: { id: existing.id } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'attendance.otRule.delete', entityType: 'OvertimeRule', entityId: existing.id }).catch(() => {});
    res.json({ deleted: true });
  } catch (e) { next(e); }
}

// ── Late-coming rules ─────────────────────────────────────────────────────────

function pickLateData(b) {
  const data = {};
  if (b.allowedLatesPerMonth !== undefined) {
    const v = Number(b.allowedLatesPerMonth);
    if (!Number.isInteger(v) || v < 0 || v > 31) return { error: 'allowedLatesPerMonth must be 0–31' };
    data.allowedLatesPerMonth = v;
  }
  if (b.perLates !== undefined) {
    const v = Number(b.perLates);
    if (!Number.isInteger(v) || v < 1 || v > 31) return { error: 'perLates must be 1–31' };
    data.perLates = v;
  }
  if (b.penaltyDayFraction !== undefined) {
    const v = Number(b.penaltyDayFraction);
    if (![0.25, 0.5, 1].includes(v)) return { error: 'penaltyDayFraction must be 0.25, 0.5 or 1' };
    data.penaltyDayFraction = v;
  }
  if (b.isActive !== undefined) data.isActive = b.isActive === true;
  return { data };
}

async function listLateRules(req, res, next) {
  try {
    const { businessId } = req.user;
    const items = await prisma.lateComingRule.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } });
    res.json({ items });
  } catch (e) { next(e); }
}

async function createLateRule(req, res, next) {
  try {
    const { businessId } = req.user;
    const b = req.body || {};
    if (!(await validateScope(businessId, b, res))) return;
    const { data, error } = pickLateData(b);
    if (error) return res.status(400).json({ message: error });
    const row = await prisma.lateComingRule.create({
      data: { businessId, entityId: b.entityId || null, locationId: b.locationId || null, ...data },
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'attendance.lateRule.create', entityType: 'LateComingRule', entityId: row.id }).catch(() => {});
    res.status(201).json(row);
  } catch (e) { next(e); }
}

async function updateLateRule(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.lateComingRule.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Late-coming rule not found' });
    const { data, error } = pickLateData(req.body || {});
    if (error) return res.status(400).json({ message: error });
    const row = await prisma.lateComingRule.update({ where: { id: existing.id }, data });
    await writeAudit({ businessId, actorId: req.user.id, action: 'attendance.lateRule.update', entityType: 'LateComingRule', entityId: row.id, meta: data }).catch(() => {});
    res.json(row);
  } catch (e) { next(e); }
}

async function deleteLateRule(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.lateComingRule.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Late-coming rule not found' });
    await prisma.lateComingRule.delete({ where: { id: existing.id } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'attendance.lateRule.delete', entityType: 'LateComingRule', entityId: existing.id }).catch(() => {});
    res.json({ deleted: true });
  } catch (e) { next(e); }
}

module.exports = {
  listOtRules, createOtRule, updateOtRule, deleteOtRule,
  listLateRules, createLateRule, updateLateRule, deleteLateRule,
};
