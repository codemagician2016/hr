'use strict';
// okr.controller.js — Feature 8 §5.6: Objectives / KeyResults / GoalCheckIns.
//
// Scoped exactly like reviews/goals: F1 scopeWhere on ownerEmployeeId for lists,
// scopeAllows on single-row. Progress is NEVER authored on an Objective — it is
// ROLLED UP from KR check-ins (append-only ledger). Weight invariants (Σ=100) are
// enforced transactionally → 422 on violation. Alignment is guarded by the manager
// chain (an IC may align only to a parent owned within their own management line).
const prisma = require('../../../core/lib/prisma');
const { scopeWhere, scopeAllows } = require('../../lib/scopeResolver');
const { writeAudit } = require('../../../core/lib/audit');
const { objectiveProgress, checkWeightSum, krProgress, num } = require('../performance/goalRollup');
const { resolveManagerChainEmployeeIds } = require('../performance/managerChain');

const STALE_MSG = 'This record was updated elsewhere — reload and try again';

async function lockedUpdate(tx, model, id, expected, data) {
  const res = await tx[model].updateMany({ where: { id, version: expected }, data: { ...data, version: { increment: 1 } } });
  if (res.count === 0) return null;
  return tx[model].findUnique({ where: { id } });
}

// ── Objectives ────────────────────────────────────────────────────────────────
async function listObjectives(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId, ...scopeWhere(req.scope, 'ownerEmployeeId') };
    if (req.query.ownerEmployeeId && scopeAllows(req.scope, req.query.ownerEmployeeId)) where.ownerEmployeeId = req.query.ownerEmployeeId;
    if (req.query.cycleId) where.cycleId = req.query.cycleId;
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.objective.findMany({ where, orderBy: { createdAt: 'desc' }, include: { keyResults: true } });
    res.json({ items });
  } catch (e) { next(e); }
}

async function getObjective(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.objective.findFirst({ where: { id: req.params.id, businessId }, include: { keyResults: { include: { checkIns: { orderBy: { createdAt: 'desc' }, take: 5 } } }, alignmentsAsChild: true } });
    if (!item) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllows(req.scope, item.ownerEmployeeId)) return res.status(404).json({ message: 'Not found' });
    res.json(item);
  } catch (e) { next(e); }
}

// POST /objectives — owner must be in scope. Alignment parent (if any) must be owned
// within the actor's manager chain (the inverse of TEAM).
async function createObjective(req, res, next) {
  try {
    const { businessId } = req.user;
    const { ownerEmployeeId, level, title, weight, dueDate, parentObjectiveId } = req.body;
    if (!ownerEmployeeId || !level || !title || weight === undefined || !dueDate) {
      return res.status(400).json({ message: 'ownerEmployeeId, level, title, weight, dueDate are required' });
    }
    if (!scopeAllows(req.scope, ownerEmployeeId)) return res.status(404).json({ message: 'Owner not in scope' });

    if (parentObjectiveId) {
      const parent = await prisma.objective.findFirst({ where: { id: parentObjectiveId, businessId }, select: { ownerEmployeeId: true } });
      if (!parent) return res.status(404).json({ message: 'Parent objective not found' });
      // Alignment guard: parent owner must be in the actor's manager chain (or self).
      const chain = await resolveManagerChainEmployeeIds(req.user);
      const allowed = chain.kind === 'IDS' && chain.ids.has(parent.ownerEmployeeId);
      if (!allowed) return res.status(422).json({ message: 'Alignment parent must be owned within your management chain' });
    }

    const data = {
      businessId, ownerEmployeeId, level, title,
      description: req.body.description || null,
      category: req.body.category || 'INDIVIDUAL',
      weight, dueDate: new Date(dueDate),
      startDate: req.body.startDate ? new Date(req.body.startDate) : null,
      cycleId: req.body.cycleId || null,
      parentObjectiveId: parentObjectiveId || null,
      visibility: req.body.visibility || 'PUBLIC',
      status: req.body.status || 'DRAFT',
    };
    const item = await prisma.objective.create({ data });
    if (parentObjectiveId) {
      await prisma.objectiveAlignment.upsert({
        where: { businessId_childObjectiveId_parentObjectiveId: { businessId, childObjectiveId: item.id, parentObjectiveId } },
        create: { businessId, childObjectiveId: item.id, parentObjectiveId, alignmentWeight: num(req.body.alignmentWeight) || 100 },
        update: { alignmentWeight: num(req.body.alignmentWeight) || 100 },
      });
    }
    await writeAudit({ businessId, actorId: req.user.id, action: 'objective.create', entityType: 'Objective', entityId: item.id, meta: { ownerEmployeeId, level } });
    res.status(201).json(item);
  } catch (e) { next(e); }
}

async function updateObjective(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.objective.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllows(req.scope, existing.ownerEmployeeId)) return res.status(404).json({ message: 'Not found' });
    const expected = req.body.version !== undefined ? Number(req.body.version) : existing.version;
    const data = {};
    for (const f of ['title', 'description', 'weight', 'status', 'visibility', 'category', 'cycleId']) {
      if (req.body[f] !== undefined) data[f] = req.body[f];
    }
    if (req.body.dueDate !== undefined) data.dueDate = new Date(req.body.dueDate);
    if (req.body.startDate !== undefined) data.startDate = req.body.startDate ? new Date(req.body.startDate) : null;
    // progress is read-only — silently dropped if sent.
    const updated = await lockedUpdate(prisma, 'objective', existing.id, expected, data);
    if (!updated) return res.status(409).json({ message: STALE_MSG });
    res.json(updated);
  } catch (e) { next(e); }
}

// POST /objectives/:id/validate-weights — Σ(KR.weight)=100 and the owner/cycle
// objective weights = 100. Returns {ok, krSum, objectiveSum} (422 when violated).
async function validateObjectiveWeights(req, res, next) {
  try {
    const { businessId } = req.user;
    const obj = await prisma.objective.findFirst({ where: { id: req.params.id, businessId }, include: { keyResults: true } });
    if (!obj) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllows(req.scope, obj.ownerEmployeeId)) return res.status(404).json({ message: 'Not found' });
    const kr = checkWeightSum(obj.keyResults, 'weight');
    const siblings = await prisma.objective.findMany({ where: { businessId, ownerEmployeeId: obj.ownerEmployeeId, cycleId: obj.cycleId }, select: { weight: true } });
    const objSum = checkWeightSum(siblings, 'weight');
    const ok = kr.ok && objSum.ok;
    res.status(ok ? 200 : 422).json({ ok, krSum: kr.sum, krOk: kr.ok, objectiveSum: objSum.sum, objectiveOk: objSum.ok });
  } catch (e) { next(e); }
}

// ── Key Results ───────────────────────────────────────────────────────────────
async function createKeyResult(req, res, next) {
  try {
    const { businessId } = req.user;
    const obj = await prisma.objective.findFirst({ where: { id: req.params.id, businessId } });
    if (!obj) return res.status(404).json({ message: 'Objective not found' });
    if (!scopeAllows(req.scope, obj.ownerEmployeeId)) return res.status(404).json({ message: 'Not found' });
    const { title, metricType, startValue, targetValue, weight } = req.body;
    if (!title || !metricType || startValue === undefined || targetValue === undefined || weight === undefined) {
      return res.status(400).json({ message: 'title, metricType, startValue, targetValue, weight are required' });
    }
    const kr = await prisma.keyResult.create({
      data: {
        businessId, objectiveId: obj.id, title, metricType,
        startValue, targetValue,
        currentValue: req.body.currentValue !== undefined ? req.body.currentValue : startValue,
        unit: req.body.unit || null,
        direction: req.body.direction || 'INCREASE',
        weight,
        confidence: req.body.confidence || 'ON_TRACK',
        status: req.body.status || 'ACTIVE',
      },
    });
    await rollupObjective(prisma, obj.id);
    res.status(201).json(kr);
  } catch (e) { next(e); }
}

// POST /key-results/:id/check-ins — append-only ledger entry that moves currentValue
// and triggers an objective rollup. The ONLY way KR/objective progress changes.
async function createCheckIn(req, res, next) {
  try {
    const { businessId } = req.user;
    const kr = await prisma.keyResult.findFirst({ where: { id: req.params.id, businessId }, include: { objective: { select: { id: true, ownerEmployeeId: true } } } });
    if (!kr) return res.status(404).json({ message: 'Key result not found' });
    if (!scopeAllows(req.scope, kr.objective.ownerEmployeeId)) return res.status(404).json({ message: 'Not found' });
    if (req.body.newValue === undefined) return res.status(400).json({ message: 'newValue is required' });

    const author = (req.user.employeeId) || kr.objective.ownerEmployeeId;
    const out = await prisma.$transaction(async (tx) => {
      const checkIn = await tx.goalCheckIn.create({
        data: {
          businessId, keyResultId: kr.id, authorEmployeeId: author,
          previousValue: kr.currentValue, newValue: req.body.newValue,
          confidence: req.body.confidence || kr.confidence, note: req.body.note || null,
        },
      });
      const data = { currentValue: req.body.newValue };
      if (req.body.confidence) data.confidence = req.body.confidence;
      await lockedUpdate(tx, 'keyResult', kr.id, kr.version, data);
      await rollupObjective(tx, kr.objective.id);
      return checkIn;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
}

// Recompute Objective.progress from its KRs (weighted mean) + roll up to the parent.
async function rollupObjective(client, objectiveId) {
  const obj = await client.objective.findUnique({ where: { id: objectiveId }, include: { keyResults: true } });
  if (!obj) return;
  const progress = objectiveProgress(obj.keyResults);
  await client.objective.update({ where: { id: objectiveId }, data: { progress } });
  if (obj.parentObjectiveId) {
    const children = await client.objectiveAlignment.findMany({
      where: { businessId: obj.businessId, parentObjectiveId: obj.parentObjectiveId },
      select: { childObjectiveId: true, alignmentWeight: true },
    });
    let acc = 0;
    for (const c of children) {
      const child = await client.objective.findUnique({ where: { id: c.childObjectiveId }, select: { progress: true } });
      if (child) acc += num(child.progress) * (num(c.alignmentWeight) / 100);
    }
    await client.objective.update({ where: { id: obj.parentObjectiveId }, data: { progress: Math.round(acc * 100) / 100 } });
  }
}

module.exports = {
  listObjectives, getObjective, createObjective, updateObjective, validateObjectiveWeights,
  createKeyResult, createCheckIn,
  _internals: { rollupObjective, krProgress },
};
