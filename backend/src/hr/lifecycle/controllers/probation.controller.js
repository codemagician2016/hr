'use strict';

/**
 * probation.controller.js — Program P1.4: tenant PROBATION POLICY.
 *
 * Replaces the hardcoded 90-day default (provision.js hotlist item) with
 * scoped, tenant-authorable policy rows:
 *
 *   GET    /lifecycle/probation-policies          list
 *   POST   /lifecycle/probation-policies          create
 *   PATCH  /lifecycle/probation-policies/:id      update
 *   DELETE /lifecycle/probation-policies/:id      hard delete (config row)
 *
 * Resolution (most-specific wins; used by provision.js + the nightly sweep):
 *   (entityId + employmentType) > entityId > employmentType > tenant-wide.
 * Policy fields: probationDays, autoConfirm (nightly sweep flips
 * PROBATION→ACTIVE at end date), letterTemplateId (CONFIRMATION letter issued
 * on auto-confirm), remindDaysBefore (HR nudge before the end date).
 */

const prisma = require('../../../core/lib/prisma');

const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'FIXED_TERM', 'CONTRACT', 'INTERN', 'APPRENTICE', 'CASUAL', 'CONSULTANT'];

function validate(b) {
  if (b.probationDays != null && (!Number.isInteger(b.probationDays) || b.probationDays < 0 || b.probationDays > 730)) {
    return 'probationDays must be an integer between 0 and 730.';
  }
  if (b.remindDaysBefore != null && (!Number.isInteger(b.remindDaysBefore) || b.remindDaysBefore < 0 || b.remindDaysBefore > 60)) {
    return 'remindDaysBefore must be an integer between 0 and 60.';
  }
  if (b.employmentType != null && !EMPLOYMENT_TYPES.includes(b.employmentType)) {
    return `employmentType must be one of ${EMPLOYMENT_TYPES.join(', ')} (or empty for all types).`;
  }
  return null;
}

async function checkRefs(businessId, b) {
  if (b.entityId) {
    const e = await prisma.entity.findFirst({ where: { id: b.entityId, businessId, deletedAt: null }, select: { id: true } });
    if (!e) return 'entityId is not an entity of this tenant.';
  }
  if (b.letterTemplateId) {
    const t = await prisma.letterTemplate.findFirst({ where: { id: b.letterTemplateId, businessId, deletedAt: null }, select: { id: true } });
    if (!t) return 'letterTemplateId is not a letter template of this tenant.';
  }
  return null;
}

async function list(req, res, next) {
  try {
    const { businessId } = req.user;
    const items = await prisma.probationPolicy.findMany({
      where: { businessId },
      orderBy: [{ entityId: 'asc' }, { employmentType: 'asc' }, { createdAt: 'asc' }],
    });
    res.json({ items });
  } catch (e) { next(e); }
}

async function create(req, res, next) {
  try {
    const { businessId } = req.user;
    const b = req.body || {};
    const invalid = validate(b) || (await checkRefs(businessId, b));
    if (invalid) return res.status(400).json({ message: invalid });
    // One policy per scope cell — duplicate scope rows would make resolution ambiguous.
    const dupe = await prisma.probationPolicy.findFirst({
      where: { businessId, entityId: b.entityId || null, employmentType: b.employmentType || null },
    });
    if (dupe) return res.status(409).json({ message: 'A probation policy for this scope already exists — edit it instead.' });
    const item = await prisma.probationPolicy.create({
      data: {
        businessId,
        entityId: b.entityId || null,
        employmentType: b.employmentType || null,
        probationDays: b.probationDays != null ? b.probationDays : 90,
        autoConfirm: b.autoConfirm === true,
        letterTemplateId: b.letterTemplateId || null,
        remindDaysBefore: b.remindDaysBefore != null ? b.remindDaysBefore : 7,
        isActive: b.isActive !== false,
      },
    });
    res.status(201).json(item);
  } catch (e) { next(e); }
}

async function update(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.probationPolicy.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Probation policy not found' });
    const b = req.body || {};
    const invalid = validate(b) || (await checkRefs(businessId, b));
    if (invalid) return res.status(400).json({ message: invalid });
    const data = {};
    for (const f of ['probationDays', 'autoConfirm', 'remindDaysBefore', 'isActive']) {
      if (b[f] !== undefined) data[f] = b[f];
    }
    if (b.letterTemplateId !== undefined) data.letterTemplateId = b.letterTemplateId || null;
    // Scope (entityId/employmentType) is immutable — delete and recreate to re-scope.
    const item = await prisma.probationPolicy.update({ where: { id: existing.id }, data });
    res.json(item);
  } catch (e) { next(e); }
}

async function remove(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.probationPolicy.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Probation policy not found' });
    await prisma.probationPolicy.delete({ where: { id: existing.id } });
    res.status(204).end();
  } catch (e) { next(e); }
}

/**
 * resolveProbationPolicy(db, { businessId, entityId, employmentType })
 * Most-specific active row wins: (entity+type) > entity > type > tenant-wide.
 * Returns the policy row or null. Shared by provision.js and the nightly sweep.
 */
async function resolveProbationPolicy(db, { businessId, entityId = null, employmentType = null }) {
  const rows = await db.probationPolicy.findMany({ where: { businessId, isActive: true } });
  if (!rows.length) return null;
  const score = (p) => (p.entityId ? 2 : 0) + (p.employmentType ? 1 : 0);
  let best = null;
  for (const p of rows) {
    if (p.entityId && p.entityId !== entityId) continue;
    if (p.employmentType && p.employmentType !== employmentType) continue;
    if (!best || score(p) > score(best)) best = p;
  }
  return best;
}

module.exports = { list, create, update, remove, resolveProbationPolicy };
