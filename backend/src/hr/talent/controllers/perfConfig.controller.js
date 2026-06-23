'use strict';
// perfConfig.controller.js — Feature 8: review templates + rating scales (config),
// 1:1 notes, and the merit-recommendation read surface. Tenant-scoped; config writes
// are HR-Admin (canManagePerformanceCycle, enforced at the route). 1:1 privateNotes
// are stripped from the ESS surface (in essPerformance.controller); on this operator
// surface a manager/HR sees them.
const prisma = require('../../../core/lib/prisma');
const { scopeAllows } = require('../../lib/scopeResolver');
const { writeAudit } = require('../../../core/lib/audit');

const STALE_MSG = 'This record was updated elsewhere — reload and try again';
async function locked(model, id, expected, data) {
  const r = await prisma[model].updateMany({ where: { id, version: expected }, data: { ...data, version: { increment: 1 } } });
  if (r.count === 0) return null;
  return prisma[model].findUnique({ where: { id } });
}

// ── Review templates ────────────────────────────────────────────────────────
async function listTemplates(req, res, next) {
  try {
    const items = await prisma.reviewTemplate.findMany({ where: { businessId: req.user.businessId }, orderBy: { createdAt: 'desc' } });
    res.json({ items });
  } catch (e) { next(e); }
}
async function createTemplate(req, res, next) {
  try {
    const { businessId } = req.user;
    if (!req.body.name || req.body.sectionsJson === undefined) return res.status(400).json({ message: 'name and sectionsJson are required' });
    const item = await prisma.reviewTemplate.create({ data: { businessId, name: req.body.name, ratingScaleId: req.body.ratingScaleId || null, sectionsJson: req.body.sectionsJson } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'template.create', entityType: 'ReviewTemplate', entityId: item.id });
    res.status(201).json(item);
  } catch (e) { next(e); }
}
async function updateTemplate(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.reviewTemplate.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    const expected = req.body.version !== undefined ? Number(req.body.version) : existing.version;
    const data = {};
    for (const f of ['name', 'ratingScaleId', 'sectionsJson']) if (req.body[f] !== undefined) data[f] = req.body[f];
    const updated = await locked('reviewTemplate', existing.id, expected, data);
    if (!updated) return res.status(409).json({ message: STALE_MSG });
    res.json(updated);
  } catch (e) { next(e); }
}

// ── Rating scales ──────────────────────────────────────────────────────────
async function listScales(req, res, next) {
  try {
    const items = await prisma.ratingScale.findMany({ where: { businessId: req.user.businessId }, orderBy: { createdAt: 'desc' } });
    res.json({ items });
  } catch (e) { next(e); }
}
async function createScale(req, res, next) {
  try {
    const { businessId } = req.user;
    if (!req.body.name || req.body.pointsJson === undefined) return res.status(400).json({ message: 'name and pointsJson are required' });
    const item = await prisma.ratingScale.create({
      data: { businessId, name: req.body.name, pointsJson: req.body.pointsJson, allowsHalfPoints: req.body.allowsHalfPoints !== false, forcedDistributionJson: req.body.forcedDistributionJson || null },
    });
    res.status(201).json(item);
  } catch (e) { next(e); }
}
async function updateScale(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.ratingScale.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    // Guard: a scale bound to an ACTIVE cycle is locked — clone to edit.
    const boundActive = await prisma.reviewCycle.findFirst({ where: { businessId, ratingScaleId: existing.id, status: { in: ['ACTIVE', 'SELF_REVIEW', 'MANAGER_REVIEW', 'CALIBRATION'] } }, select: { id: true } });
    if (boundActive) return res.status(409).json({ message: 'Scale is bound to an active cycle — clone to edit' });
    const data = {};
    for (const f of ['name', 'pointsJson', 'allowsHalfPoints', 'forcedDistributionJson']) if (req.body[f] !== undefined) data[f] = req.body[f];
    const updated = await prisma.ratingScale.update({ where: { id: existing.id }, data });
    res.json(updated);
  } catch (e) { next(e); }
}

// ── 1:1s ───────────────────────────────────────────────────────────────────
async function listOneOnOnes(req, res, next) {
  try {
    const { businessId } = req.user;
    const me = req.user.employeeId || null;
    // A manager sees 1:1s they own or are about a report (scope). HR sees all.
    const where = { businessId };
    if (req.scope && req.scope.kind === 'IDS') {
      where.OR = [{ managerEmployeeId: me }, { employeeEmployeeId: { in: [...req.scope.ids] } }];
    }
    const items = await prisma.oneOnOne.findMany({ where, orderBy: { scheduledAt: 'desc' } });
    res.json({ items });
  } catch (e) { next(e); }
}
async function createOneOnOne(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeEmployeeId, scheduledAt } = req.body;
    if (!employeeEmployeeId || !scheduledAt) return res.status(400).json({ message: 'employeeEmployeeId and scheduledAt are required' });
    if (!scopeAllows(req.scope, employeeEmployeeId)) return res.status(404).json({ message: 'Employee not in scope' });
    const item = await prisma.oneOnOne.create({
      data: {
        businessId, managerEmployeeId: req.user.employeeId || employeeEmployeeId, employeeEmployeeId,
        scheduledAt: new Date(scheduledAt),
        agendaJson: req.body.agendaJson || null, sharedNotes: req.body.sharedNotes || null,
        privateNotes: req.body.privateNotes || null, actionItemsJson: req.body.actionItemsJson || null,
      },
    });
    res.status(201).json(item);
  } catch (e) { next(e); }
}
async function updateOneOnOne(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.oneOnOne.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllows(req.scope, existing.employeeEmployeeId) && existing.managerEmployeeId !== req.user.employeeId) {
      return res.status(404).json({ message: 'Not found' });
    }
    const expected = req.body.version !== undefined ? Number(req.body.version) : existing.version;
    const data = {};
    for (const f of ['agendaJson', 'sharedNotes', 'privateNotes', 'actionItemsJson']) if (req.body[f] !== undefined) data[f] = req.body[f];
    if (req.body.scheduledAt !== undefined) data.scheduledAt = new Date(req.body.scheduledAt);
    const updated = await locked('oneOnOne', existing.id, expected, data);
    if (!updated) return res.status(409).json({ message: STALE_MSG });
    res.json(updated);
  } catch (e) { next(e); }
}

// ── Merit recommendations (read) ────────────────────────────────────────────
async function listMeritRecommendations(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId };
    if (req.query.cycleId) where.cycleId = req.query.cycleId;
    if (req.query.status) where.status = req.query.status;
    // Scope by subject employee for non-HR viewers.
    if (req.scope && req.scope.kind === 'IDS') where.subjectEmployeeId = { in: [...req.scope.ids] };
    const items = await prisma.meritRecommendation.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({ items });
  } catch (e) { next(e); }
}

module.exports = {
  listTemplates, createTemplate, updateTemplate,
  listScales, createScale, updateScale,
  listOneOnOnes, createOneOnOne, updateOneOnOne,
  listMeritRecommendations,
};
