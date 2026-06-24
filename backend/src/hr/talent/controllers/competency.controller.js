'use strict';
// competency.controller.js — Feature 34 Slice 1: the competency framework config
// (library + role→competency map). HR-Admin config surface (canManagePerformanceCycle,
// enforced at the route — the SAME key that gates scales/templates). Tenant-scoped on
// businessId; optimistic-locked on every mutation (perfConfig.controller `locked()`
// pattern); the active-cycle scale-lock guard protects the map once a consuming cycle
// launches. Competency ASSESSMENT is captured as existing ReviewResponse rows — there
// is no per-item table here; this controller only manages the catalog + the role map.
const prisma = require('../../../core/lib/prisma');
const { writeAudit } = require('../../../core/lib/audit');

const DUP_MSG = 'A record with that code already exists';
const STALE_MSG = 'This record was updated elsewhere — reload and try again';

async function locked(model, id, expected, data) {
  const r = await prisma[model].updateMany({ where: { id, version: expected }, data: { ...data, version: { increment: 1 } } });
  if (r.count === 0) return null;
  return prisma[model].findUnique({ where: { id } });
}

// ── Competency library ────────────────────────────────────────────────────────
const COMP_FIELDS = ['code', 'name', 'category', 'description', 'scaleId', 'isActive'];
function pickComp(body) {
  const out = {};
  for (const f of COMP_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

async function listCompetencies(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId };
    if (req.query.category) where.category = req.query.category;
    if (req.query.active !== undefined) where.isActive = req.query.active === 'true' || req.query.active === true;
    const items = await prisma.competency.findMany({ where, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
    res.json({ items });
  } catch (e) { next(e); }
}

async function createCompetency(req, res, next) {
  try {
    const { businessId } = req.user;
    for (const r of ['code', 'name']) {
      if (req.body[r] === undefined || req.body[r] === null || req.body[r] === '') {
        return res.status(400).json({ message: `${r} is required` });
      }
    }
    const item = await prisma.competency.create({ data: { ...pickComp(req.body), businessId } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'competency.create', entityType: 'Competency', entityId: item.id, meta: { code: item.code } });
    res.status(201).json(item);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: DUP_MSG }); next(e); }
}

async function updateCompetency(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.competency.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    const expected = req.body.version !== undefined ? Number(req.body.version) : existing.version;
    const data = pickComp(req.body);
    delete data.code; // stable key; never re-keyed via update
    const updated = await locked('competency', existing.id, expected, data);
    if (!updated) return res.status(409).json({ message: STALE_MSG });
    await writeAudit({ businessId, actorId: req.user.id, action: 'competency.update', entityType: 'Competency', entityId: existing.id });
    res.json(updated);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: DUP_MSG }); next(e); }
}

// ── Role → competency map ─────────────────────────────────────────────────────
// GET /role-competencies?roleKey=… — the competency set for a role (or all roles).
async function listRoleCompetencies(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId };
    if (req.query.roleKey) where.roleKey = req.query.roleKey;
    if (req.query.competencyId) where.competencyId = req.query.competencyId;
    const items = await prisma.roleCompetency.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: { competency: { select: { id: true, code: true, name: true, category: true, scaleId: true, isActive: true } } },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

// Is a roleKey consumed by a cycle that has already launched? (scale-lock parity.)
// A launched cycle freezes its competency expectations so the grid is reproducible.
async function roleMapLocked(businessId) {
  const active = await prisma.reviewCycle.findFirst({
    where: { businessId, status: { in: ['ACTIVE', 'SELF_REVIEW', 'MANAGER_REVIEW', 'CALIBRATION'] } },
    select: { id: true },
  });
  return !!active;
}

async function createRoleCompetency(req, res, next) {
  try {
    const { businessId } = req.user;
    const { competencyId, roleKey, expectedLevel } = req.body;
    if (!competencyId || !roleKey || expectedLevel === undefined || expectedLevel === null) {
      return res.status(400).json({ message: 'competencyId, roleKey and expectedLevel are required' });
    }
    if (await roleMapLocked(businessId)) {
      return res.status(409).json({ message: 'A review cycle is active — the role-competency map is locked. Clone or wait for cycle close.' });
    }
    const comp = await prisma.competency.findFirst({ where: { id: competencyId, businessId }, select: { id: true } });
    if (!comp) return res.status(404).json({ message: 'Competency not found' });
    const item = await prisma.roleCompetency.create({
      data: { businessId, competencyId, roleKey, expectedLevel, weight: req.body.weight !== undefined ? req.body.weight : null },
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'roleCompetency.create', entityType: 'RoleCompetency', entityId: item.id, meta: { roleKey, competencyId } });
    res.status(201).json(item);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: 'That competency is already mapped to this role' }); next(e); }
}

async function updateRoleCompetency(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.roleCompetency.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    if (await roleMapLocked(businessId)) {
      return res.status(409).json({ message: 'A review cycle is active — the role-competency map is locked.' });
    }
    const expected = req.body.version !== undefined ? Number(req.body.version) : existing.version;
    const data = {};
    if (req.body.expectedLevel !== undefined) data.expectedLevel = req.body.expectedLevel;
    if (req.body.weight !== undefined) data.weight = req.body.weight;
    const updated = await locked('roleCompetency', existing.id, expected, data);
    if (!updated) return res.status(409).json({ message: STALE_MSG });
    res.json(updated);
  } catch (e) { next(e); }
}

async function removeRoleCompetency(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.roleCompetency.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    if (await roleMapLocked(businessId)) {
      return res.status(409).json({ message: 'A review cycle is active — the role-competency map is locked.' });
    }
    await prisma.roleCompetency.delete({ where: { id: existing.id } });
    res.status(204).end();
  } catch (e) { next(e); }
}

module.exports = {
  listCompetencies, createCompetency, updateCompetency,
  listRoleCompetencies, createRoleCompetency, updateRoleCompetency, removeRoleCompetency,
  _internals: { roleMapLocked },
};
