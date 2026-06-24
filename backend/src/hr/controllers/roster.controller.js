'use strict';

/**
 * roster.controller.js — Feature 29 (shift management) hr-admin operator surface.
 * Mounted under /api/hr/attendance/roster|rotations|swaps. Tenant-scoped by
 * req.user.businessId on EVERY query; employee-facing reads/writes are additionally
 * F1-scoped (scopeWhere/scopeAllows). Reuses the attendance period-lock guard (E1),
 * the pure rotation generator (rotation.js), and the F10 SHIFT_SWAP approval engine.
 *
 *   RosterDay  — the per-employee-per-day cell (DRAFT → PUBLISHED; derive reads PUBLISHED).
 *   RotationTemplate — a reusable rotation ring; /apply materialises DRAFT cells.
 *   ShiftSwapRequest — manager approve/reject drives the F10 engine (consumers.shiftSwap).
 */

const prisma = require('../../core/lib/prisma');
const { scopeWhere, scopeAllows } = require('../lib/scopeResolver');
const { recompute } = require('../attendance/service');
const { generateRoster } = require('../attendance/roster/rotation');
const engine = require('../approvals/engine');

// ── civil-day helpers (match the Attendance @db.Date midnight-UTC convention) ──
function utcDay(value) {
  const t = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}
function dayKey(value) {
  return utcDay(value).toISOString().slice(0, 10);
}
function eachDay(from, to) {
  const out = [];
  for (let d = utcDay(from); d.getTime() <= utcDay(to).getTime(); d = new Date(d.getTime() + 86400000)) out.push(new Date(d));
  return out;
}
function clampLimit(q, dflt = 50, max = 200) {
  return Math.min(Math.max(parseInt(q.limit, 10) || dflt, 1), max);
}

// True when the (employee, civil-day) lands on a LOCKED Attendance row (E1).
async function isDayLocked(businessId, employeeId, day) {
  const row = await prisma.attendance.findFirst({
    where: { businessId, employeeId, date: utcDay(day), isLocked: true },
    select: { id: true },
  });
  return !!row;
}

// Resolve a sub-tree population for the grid / a rotation apply. Honours F1 scope.
// employeeIds (explicit pick) ∩ scope, else entity/dept-filtered ∩ scope.
async function resolvePopulation(businessId, scope, { entityId, deptId, employeeIds }) {
  const where = { businessId, deletedAt: null, ...scopeWhere(scope, 'id') };
  if (Array.isArray(employeeIds) && employeeIds.length) where.id = { in: employeeIds.filter((id) => scopeAllows(scope, id)) };
  if (deptId) where.departmentId = deptId;
  if (entityId) {
    where.employmentRecords = { some: { businessId, isCurrent: true, entityId } };
  }
  return prisma.employee.findMany({
    where,
    select: { id: true, code: true, firstName: true, lastName: true, nightShiftEligible: true },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    take: 1000,
  });
}

/* ------------------------------------------------------------------ */
/* Roster grid + cells                                                */
/* ------------------------------------------------------------------ */

// GET /roster/grid?from&to&entityId&deptId&cursor&limit
// Paginated BY EMPLOYEE (keyset on employee id). Each node = { employee, cells:[...] }.
async function rosterGrid(req, res, next) {
  try {
    const { businessId } = req.user;
    const { from, to, entityId, deptId, cursor } = req.query;
    if (!from || !to) return res.status(400).json({ message: 'from and to are required' });
    const limit = clampLimit(req.query, 50, 200);

    const where = { businessId, deletedAt: null, ...scopeWhere(req.scope, 'id') };
    if (deptId) where.departmentId = deptId;
    if (entityId) where.employmentRecords = { some: { businessId, isCurrent: true, entityId } };
    if (cursor) where.id = { gt: cursor };

    const employees = await prisma.employee.findMany({
      where,
      select: { id: true, code: true, firstName: true, lastName: true, nightShiftEligible: true },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    const hasMore = employees.length > limit;
    const page = hasMore ? employees.slice(0, limit) : employees;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    const empIds = page.map((e) => e.id);
    const cells = empIds.length
      ? await prisma.rosterDay.findMany({
          where: { businessId, employeeId: { in: empIds }, date: { gte: utcDay(from), lte: utcDay(to) } },
          include: { shiftPattern: { select: { id: true, code: true, name: true, startTime: true, endTime: true, breakMinutes: true, isNightShift: true } } },
        })
      : [];
    const byEmp = new Map();
    for (const c of cells) {
      if (!byEmp.has(c.employeeId)) byEmp.set(c.employeeId, []);
      byEmp.get(c.employeeId).push({
        id: c.id, date: dayKey(c.date), dayType: c.dayType, status: c.status, source: c.source,
        shift: c.shiftPattern || null, version: c.version,
      });
    }
    const nodes = page.map((e) => ({ employee: e, cells: (byEmp.get(e.id) || []).sort((a, b) => (a.date < b.date ? -1 : 1)) }));
    res.json({ nodes, nextCursor, hasMore });
  } catch (e) { next(e); }
}

// GET /roster/days?employeeId&from&to — flat cell list for one employee.
async function rosterDays(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, from, to } = req.query;
    if (!employeeId || !from || !to) return res.status(400).json({ message: 'employeeId, from and to are required' });
    if (!scopeAllows(req.scope, employeeId)) return res.json({ items: [] });
    const items = await prisma.rosterDay.findMany({
      where: { businessId, employeeId, date: { gte: utcDay(from), lte: utcDay(to) } },
      include: { shiftPattern: true },
      orderBy: { date: 'asc' },
    });
    res.json({ items: items.map((c) => ({ ...c, date: dayKey(c.date) })) });
  } catch (e) { next(e); }
}

// Validate + normalise one cell payload to RosterDay data. Returns { data } or { error }.
async function buildCellData(businessId, { employeeId, date, dayType, shiftPatternId, note, source }) {
  const dt = (dayType || 'WORK').toUpperCase();
  if (dt !== 'WORK' && dt !== 'OFF') return { error: 'dayType must be WORK or OFF' };
  let pid = null;
  if (dt === 'WORK') {
    if (!shiftPatternId) return { error: 'a WORK cell requires shiftPatternId' };
    const pat = await prisma.shiftPattern.findFirst({ where: { id: shiftPatternId, businessId, deletedAt: null } });
    if (!pat) return { error: 'shiftPattern not found' };
    pid = pat.id;
  }
  return { data: { dayType: dt, shiftPatternId: pid, note: note || null, source: (source || 'MANUAL').toUpperCase() } };
}

// PUT /roster/cell — upsert one RosterDay (manual override). 409 if locked.
async function upsertCell(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, date } = req.body;
    if (!employeeId || !date) return res.status(400).json({ message: 'employeeId and date are required' });
    if (!scopeAllows(req.scope, employeeId)) return res.status(404).json({ message: 'Employee not found' });
    if (await isDayLocked(businessId, employeeId, date)) {
      return res.status(409).json({ message: 'Attendance for this day is locked (period closed)' });
    }
    const built = await buildCellData(businessId, { ...req.body });
    if (built.error) return res.status(400).json({ message: built.error });
    const cell = await prisma.rosterDay.upsert({
      where: { businessId_employeeId_date: { businessId, employeeId, date: utcDay(date) } },
      create: { businessId, employeeId, date: utcDay(date), status: 'DRAFT', ...built.data },
      update: { ...built.data, version: { increment: 1 } },
    });
    res.json({ ...cell, date: dayKey(cell.date) });
  } catch (e) { next(e); }
}

// POST /roster/bulk { cells:[{employeeId,date,dayType,shiftPatternId?}] } — paint a block.
async function bulkUpsert(req, res, next) {
  try {
    const { businessId } = req.user;
    const cells = Array.isArray(req.body.cells) ? req.body.cells : [];
    if (!cells.length) return res.status(400).json({ message: 'cells[] is required' });
    let written = 0;
    const skippedLocked = [];
    const rejected = [];
    for (const raw of cells) {
      if (!raw.employeeId || !raw.date || !scopeAllows(req.scope, raw.employeeId)) { rejected.push(raw); continue; }
      if (await isDayLocked(businessId, raw.employeeId, raw.date)) { skippedLocked.push({ employeeId: raw.employeeId, date: raw.date }); continue; }
      const built = await buildCellData(businessId, raw);
      if (built.error) { rejected.push({ ...raw, error: built.error }); continue; }
      await prisma.rosterDay.upsert({
        where: { businessId_employeeId_date: { businessId, employeeId: raw.employeeId, date: utcDay(raw.date) } },
        create: { businessId, employeeId: raw.employeeId, date: utcDay(raw.date), status: 'DRAFT', ...built.data },
        update: { ...built.data, version: { increment: 1 } },
      });
      written += 1;
    }
    res.json({ written, skippedLocked, rejected });
  } catch (e) { next(e); }
}

// POST /roster/publish?from&to + { employeeIds?, entityId?, deptId? } — DRAFT → PUBLISHED.
async function publish(req, res, next) {
  try {
    const { businessId } = req.user;
    const from = req.query.from || req.body.from;
    const to = req.query.to || req.body.to;
    if (!from || !to) return res.status(400).json({ message: 'from and to are required' });
    const pop = await resolvePopulation(businessId, req.scope, req.body || {});
    const empIds = pop.map((e) => e.id);
    if (!empIds.length) return res.json({ published: 0 });
    const upd = await prisma.rosterDay.updateMany({
      where: { businessId, employeeId: { in: empIds }, status: 'DRAFT', date: { gte: utcDay(from), lte: utcDay(to) } },
      data: { status: 'PUBLISHED' },
    });
    // Re-derive the published window so the daily Attendance rollup reflects the roster.
    for (const id of empIds) await recompute(businessId, id, utcDay(from), utcDay(to));
    res.json({ published: upd.count });
  } catch (e) { next(e); }
}

/* ------------------------------------------------------------------ */
/* Rotation templates                                                 */
/* ------------------------------------------------------------------ */

// Validate a rotation slots payload: cycleLength == slots.length, every WORK slot
// resolves to an active pattern. Returns { error } or { slots, cycleLength }.
async function validateSlots(businessId, slotsJson, cycleLength) {
  if (!Array.isArray(slotsJson) || !slotsJson.length) return { error: 'slotsJson must be a non-empty array' };
  if (cycleLength != null && cycleLength !== slotsJson.length) return { error: 'cycleLength must equal slots.length' };
  const workIds = slotsJson.filter((s) => s && s.kind === 'WORK').map((s) => s.shiftPatternId);
  if (slotsJson.some((s) => !s || (s.kind !== 'WORK' && s.kind !== 'OFF'))) return { error: 'each slot kind must be WORK or OFF' };
  if (workIds.some((id) => !id)) return { error: 'a WORK slot requires shiftPatternId' };
  if (workIds.length) {
    const found = await prisma.shiftPattern.findMany({ where: { id: { in: workIds }, businessId, deletedAt: null, isActive: true }, select: { id: true } });
    const ok = new Set(found.map((p) => p.id));
    const missing = workIds.filter((id) => !ok.has(id));
    if (missing.length) return { error: `WORK slot pattern(s) not found/active: ${missing.join(', ')}` };
  }
  return { slots: slotsJson, cycleLength: slotsJson.length };
}

async function listRotations(req, res, next) {
  try {
    const { businessId } = req.user;
    const items = await prisma.rotationTemplate.findMany({
      where: { businessId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

async function createRotation(req, res, next) {
  try {
    const { businessId } = req.user;
    const { code, name, slotsJson, cycleLength, anchorDate, entityId } = req.body;
    if (!code || !name || !anchorDate) return res.status(400).json({ message: 'code, name and anchorDate are required' });
    const v = await validateSlots(businessId, slotsJson, cycleLength);
    if (v.error) return res.status(400).json({ message: v.error });
    const item = await prisma.rotationTemplate.create({
      data: { businessId, code, name, entityId: entityId || null, slotsJson: v.slots, cycleLength: v.cycleLength, anchorDate: utcDay(anchorDate) },
    });
    res.status(201).json(item);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A rotation with that code already exists' });
    next(e);
  }
}

async function updateRotation(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.rotationTemplate.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Rotation not found' });
    const data = {};
    if (req.body.name != null) data.name = req.body.name;
    if (req.body.anchorDate != null) data.anchorDate = utcDay(req.body.anchorDate);
    if (req.body.isActive != null) data.isActive = !!req.body.isActive;
    if (req.body.slotsJson != null) {
      const v = await validateSlots(businessId, req.body.slotsJson, req.body.cycleLength);
      if (v.error) return res.status(400).json({ message: v.error });
      data.slotsJson = v.slots; data.cycleLength = v.cycleLength;
    }
    const item = await prisma.rotationTemplate.update({ where: { id: req.params.id }, data: { ...data, version: { increment: 1 } } });
    res.json(item);
  } catch (e) { next(e); }
}

async function removeRotation(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.rotationTemplate.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Rotation not found' });
    await prisma.rotationTemplate.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// POST /rotations/:id/apply { from, to, employeeIds?|entityId?|deptId?, phaseOffsets?, overwrite?, overrideNightConsent? }
// Generate DRAFT rows for the resolved population. Idempotent: only overwrites
// source:'ROTATION' DRAFT cells unless overwrite=true (E9). Returns { written, violations }.
async function applyRotation(req, res, next) {
  try {
    const { businessId } = req.user;
    const tmpl = await prisma.rotationTemplate.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!tmpl) return res.status(404).json({ message: 'Rotation not found' });
    const { from, to, phaseOffsets, overwrite, overrideNightConsent } = req.body;
    if (!from || !to) return res.status(400).json({ message: 'from and to are required' });

    const popEmployees = await resolvePopulation(businessId, req.scope, req.body || {});
    if (!popEmployees.length) return res.json({ written: 0, violations: [{ code: 'EMPTY_POPULATION' }] });

    // Resolve the WORK patterns the ring references (for the generator's guards).
    const workIds = (tmpl.slotsJson || []).filter((s) => s && s.kind === 'WORK').map((s) => s.shiftPatternId);
    const patterns = workIds.length
      ? await prisma.shiftPattern.findMany({ where: { id: { in: workIds }, businessId }, select: { id: true, startTime: true, endTime: true, isNightShift: true } })
      : [];
    const patternMap = new Map(patterns.map((p) => [p.id, p]));

    const offsets = phaseOffsets || {};
    const population = popEmployees.map((e) => ({
      employeeId: e.id, phaseOffset: Number(offsets[e.id] || 0), nightShiftEligible: !!e.nightShiftEligible,
    }));

    const { rows, violations } = generateRoster(
      { id: tmpl.id, slotsJson: tmpl.slotsJson, cycleLength: tmpl.cycleLength, anchorDate: tmpl.anchorDate },
      population, from, to, { shiftPatterns: patternMap, overrideNightConsent: !!overrideNightConsent },
    );

    // Upsert each row as DRAFT. Preserve a MANUAL/SWAP/PUBLISHED cell (and a ROTATION
    // cell when !overwrite). Locked days are skipped (E1).
    let written = 0;
    const skippedLocked = [];
    for (const r of rows) {
      const day = utcDay(r.date);
      if (await isDayLocked(businessId, r.employeeId, day)) { skippedLocked.push({ employeeId: r.employeeId, date: r.date }); continue; }
      const existing = await prisma.rosterDay.findUnique({ where: { businessId_employeeId_date: { businessId, employeeId: r.employeeId, date: day } } });
      if (existing && !overwrite && !(existing.source === 'ROTATION' && existing.status === 'DRAFT')) continue;
      if (existing) {
        await prisma.rosterDay.update({
          where: { id: existing.id },
          data: { dayType: r.dayType, shiftPatternId: r.shiftPatternId, source: 'ROTATION', rotationTemplateId: tmpl.id, status: 'DRAFT', version: { increment: 1 } },
        });
      } else {
        await prisma.rosterDay.create({
          data: { businessId, employeeId: r.employeeId, date: day, dayType: r.dayType, shiftPatternId: r.shiftPatternId, source: 'ROTATION', rotationTemplateId: tmpl.id, status: 'DRAFT' },
        });
      }
      written += 1;
    }
    res.json({ written, skippedLocked, violations });
  } catch (e) { next(e); }
}

/* ------------------------------------------------------------------ */
/* Shift swaps (manager queue + F10 decision)                         */
/* ------------------------------------------------------------------ */

// GET /swaps?status&employeeId — swap queue (sub-tree filtered).
async function listSwaps(req, res, next) {
  try {
    const { businessId } = req.user;
    const { status, employeeId } = req.query;
    const scope = req.scope;
    const where = { businessId };
    if (status) where.status = status;
    // Sub-tree filter: requester OR counterparty must be in scope.
    if (scope && scope.kind !== 'ALL') {
      const ids = scope.kind === 'NONE' ? [] : [...scope.ids];
      where.OR = [{ requesterEmployeeId: { in: ids } }, { counterpartyEmployeeId: { in: ids } }];
    }
    if (employeeId) {
      if (!scopeAllows(scope, employeeId)) return res.json({ items: [] });
      where.OR = [{ requesterEmployeeId: employeeId }, { counterpartyEmployeeId: employeeId }];
    }
    const items = await prisma.shiftSwapRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        requester: { select: { id: true, code: true, firstName: true, lastName: true } },
        counterparty: { select: { id: true, code: true, firstName: true, lastName: true } },
      },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

// Find the open SHIFT_SWAP ApprovalRequest for a swap (mirrors regularization).
async function findOpenApproval(businessId, swapId) {
  return prisma.approvalRequest.findFirst({
    where: { businessId, module: 'SHIFT_SWAP', entityType: 'ShiftSwapRequest', entityId: swapId, status: { in: ['PENDING', 'ESCALATED'] } },
  });
}

// POST /swaps/:id/approve — drive the F10 decision (manager green-lights). SoD excludes filer.
async function approveSwap(req, res, next) {
  return decideSwap(req, res, next, 'APPROVED');
}
async function rejectSwap(req, res, next) {
  return decideSwap(req, res, next, 'REJECTED');
}

async function decideSwap(req, res, next, decision) {
  try {
    const { businessId } = req.user;
    const swap = await prisma.shiftSwapRequest.findFirst({ where: { id: req.params.id, businessId } });
    if (!swap) return res.status(404).json({ message: 'Swap not found' });
    // F1 scope: the decider must have either party in their sub-tree.
    if (!scopeAllows(req.scope, swap.requesterEmployeeId) && !scopeAllows(req.scope, swap.counterpartyEmployeeId)) {
      return res.status(404).json({ message: 'Swap not found' });
    }
    if (swap.status !== 'PENDING') return res.status(409).json({ message: `Swap is already ${swap.status}` });
    if (decision === 'APPROVED' && swap.counterpartyConsent !== 'ACCEPTED') {
      return res.status(409).json({ message: 'Counterparty has not accepted this swap yet' });
    }
    const open = await findOpenApproval(businessId, swap.id);
    if (!open) return res.status(409).json({ message: 'No open approval for this swap' });
    const decidedBy = req.user.id || 'SYSTEM';
    await engine.recordDecision({ approvalRequestId: open.id, actorUserId: decidedBy, decision, comment: req.body.reason || null, systemActor: true });
    const fresh = await prisma.shiftSwapRequest.findUnique({ where: { id: swap.id } });
    res.json(fresh);
  } catch (e) {
    if (e && (e.code === 'DECISION_RACE' || e.code === 'P2025')) {
      return res.status(409).json({ message: 'Swap changed concurrently; please retry', reason: 'DECISION_RACE' });
    }
    if (e && e.code && String(e.code).startsWith('SWAP_')) {
      return res.status(409).json({ message: e.message, reason: e.code });
    }
    next(e);
  }
}

module.exports = {
  rosterGrid, rosterDays, upsertCell, bulkUpsert, publish,
  listRotations, createRotation, updateRotation, removeRotation, applyRotation,
  listSwaps, approveSwap, rejectSwap,
  // exported for tests
  _internals: { resolvePopulation, validateSlots, isDayLocked },
};
