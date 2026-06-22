'use strict';

/**
 * onboarding.controller.js — onboarding pipeline + task actions (Feature 4 §4.6,
 * slice 4a). Every read/write is Feature-1 scoped: HR-Admin (ALL band) sees the
 * whole tenant pipeline; a Manager (TEAM band) sees only their reporting
 * sub-tree's hires + their own manager-owned tasks. Out-of-scope single targets
 * resolve to 404 (IDOR-safe, never 403), matching the F1 posture.
 *
 * The routes attach `withEmployeeScope(action)` so `req.scope` is a resolved
 * ScopeResult; we AND `scopeWhere(req.scope, <employee field>)` into every query
 * and `scopeAllows(req.scope, employeeId)` on every single-row action.
 *
 * State transitions go through the PURE `journeyEngine` (no DB inside the engine);
 * this controller persists the engine's result inside a `$transaction`.
 */

const prisma = require('../../../core/lib/prisma');
const { scopeWhere, scopeAllows } = require('../../lib/scopeResolver');
const { advanceJourney } = require('../journeyEngine');

// Statuses that count as "blocking still open" for the advance guard.
const OPEN_BLOCKING = new Set(['PENDING', 'IN_PROGRESS', 'WAITING_APPROVAL', 'BLOCKED', 'OVERDUE', 'FAILED']);

// Resolve the subject-employee scope filter for a journey query. A journey is
// "in scope" when its subject employee is in scope. Pre-provision journeys have
// no employeeId yet — those are visible only to the ALL band (HR), because a
// manager has no hierarchy anchor to a not-yet-hired person. We model that by:
//   ALL  -> no filter (sees everything incl. pre-hire)
//   IDS  -> employeeId IN scope  (manager sees provisioned reports' journeys)
//   NONE -> nothing
function journeyScopeWhere(scope) {
  if (!scope || scope.kind === 'ALL') return {};
  if (scope.kind === 'NONE') return { id: { in: [] } };
  return { employeeId: { in: [...scope.ids] } };
}

// GET /journeys — onboarding pipeline board (scoped). Filters: stage, status.
async function listJourneys(req, res, next) {
  try {
    const { businessId } = req.user;
    const { stage, status, page = '1', pageSize = '50' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const where = {
      businessId,
      direction: 'ONBOARDING',
      deletedAt: null,
      ...journeyScopeWhere(req.scope),
    };
    if (stage) where.currentStage = stage;
    if (status) where.status = status;

    const [items, total] = await Promise.all([
      prisma.lifecycleJourney.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          tasks: { orderBy: [{ stageKey: 'asc' }, { dueDate: 'asc' }] },
        },
      }),
      prisma.lifecycleJourney.count({ where }),
    ]);
    res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take });
  } catch (e) { next(e); }
}

// GET /journeys/:id — single journey (404 out-of-scope).
async function getJourney(req, res, next) {
  try {
    const { businessId } = req.user;
    const journey = await prisma.lifecycleJourney.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: { tasks: { orderBy: [{ stageKey: 'asc' }, { dueDate: 'asc' }] } },
    });
    if (!journey) return res.status(404).json({ message: 'Journey not found' });
    // Subject-scope guard: a manager may only see their sub-tree's hires. A
    // pre-provision journey (no employeeId) is HR-only (ALL band).
    if (req.scope && req.scope.kind !== 'ALL') {
      if (!journey.employeeId || !scopeAllows(req.scope, journey.employeeId)) {
        return res.status(404).json({ message: 'Journey not found' });
      }
    }
    res.json(journey);
  } catch (e) { next(e); }
}

// GET /tasks?owner=me|all — task list scoped to the actor's assignable tasks.
//   owner=me  -> tasks assigned to the actor's own Employee (manager's own tasks)
//   owner=all -> all in-scope tasks (assignee employee in the sub-tree)
async function listTasks(req, res, next) {
  try {
    const { businessId } = req.user;
    const { owner = 'all', status, stage, page = '1', pageSize = '100' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 100, 1), 300);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const where = {
      businessId,
      journey: { direction: 'ONBOARDING', deletedAt: null },
    };
    if (status) where.status = status;
    if (stage) where.stageKey = stage;

    if (owner === 'me') {
      // Only tasks assigned to the actor themselves (by Employee or User).
      const selfEmp = req.user.employeeId || null;
      where.OR = [
        ...(selfEmp ? [{ assigneeEmployeeId: selfEmp }] : []),
        { assigneeUserId: req.user.id },
      ];
      if (!where.OR.length) return res.json({ items: [], total: 0, page: 1, pageSize: take });
    } else {
      // owner=all → scope by assignee employee (ANDed with the tenant wall).
      Object.assign(where, scopeWhere(req.scope, 'assigneeEmployeeId'));
    }

    const [items, total] = await Promise.all([
      prisma.lifecycleTask.findMany({
        where,
        orderBy: [{ dueDate: 'asc' }, { stageKey: 'asc' }],
        skip,
        take,
        include: { journey: { select: { id: true, code: true, employeeId: true, currentStage: true, status: true } } },
      }),
      prisma.lifecycleTask.count({ where }),
    ]);
    res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take });
  } catch (e) { next(e); }
}

// Load a task + its journey and enforce scope. Returns { task, journey } or sends
// a 404 (and returns null). Scope rule: the task's SUBJECT is the journey's
// employee; a manager may act only on tasks whose subject is in their sub-tree
// AND which they own (assigneeEmployeeId = self), per §4.5. HR (ALL) acts on any.
async function loadScopedTask(req, res) {
  const { businessId } = req.user;
  const task = await prisma.lifecycleTask.findFirst({
    where: { id: req.params.id, businessId },
    include: { journey: true },
  });
  if (!task || !task.journey || task.journey.deletedAt) {
    res.status(404).json({ message: 'Task not found' });
    return null;
  }
  if (req.scope && req.scope.kind !== 'ALL') {
    // Subject-scope: the journey's employee must be in the actor's sub-tree.
    const subject = task.journey.employeeId;
    const subjectInScope = subject && scopeAllows(req.scope, subject);
    // Owner-scope: a manager completes only manager-owned tasks they're assigned.
    const ownsTask = task.assigneeEmployeeId && task.assigneeEmployeeId === req.user.employeeId;
    if (!subjectInScope || !ownsTask) {
      res.status(404).json({ message: 'Task not found' });
      return null;
    }
  }
  return task;
}

// Re-run the pure engine against a journey's tasks and persist the result.
async function persistAdvance(tx, journey) {
  const tasks = await tx.lifecycleTask.findMany({ where: { journeyId: journey.id } });
  const result = advanceJourney(journey, tasks);
  if (result.currentStage !== journey.currentStage || result.status !== journey.status) {
    await tx.lifecycleJourney.update({
      where: { id: journey.id },
      data: { currentStage: result.currentStage, status: result.status, version: { increment: 1 } },
    });
  }
  return result;
}

// POST /tasks/:id/complete — mark DONE, then re-run the engine to advance the journey.
async function completeTask(req, res, next) {
  try {
    const task = await loadScopedTask(req, res);
    if (!task) return undefined;
    if (['DONE', 'SKIPPED', 'NOT_APPLICABLE'].includes(task.status)) {
      return res.status(409).json({ message: `Task already ${task.status.toLowerCase()}` });
    }
    const out = await prisma.$transaction(async (tx) => {
      const updated = await tx.lifecycleTask.update({
        where: { id: task.id },
        data: {
          status: 'DONE',
          completedAt: new Date(),
          completedByUserId: req.user.id,
          resultJson: req.body && req.body.result ? req.body.result : undefined,
          version: { increment: 1 },
        },
      });
      const journey = await tx.lifecycleJourney.findUnique({ where: { id: task.journeyId } });
      const advance = await persistAdvance(tx, journey);
      return { task: updated, journey: { id: journey.id, ...advance } };
    });
    res.json(out);
  } catch (e) { next(e); }
}

// POST /tasks/:id/skip — mark SKIPPED with a reason (non-mandatory or HR override).
async function skipTask(req, res, next) {
  try {
    const reason = req.body && req.body.reason;
    if (!reason) return res.status(400).json({ message: 'A skip reason is required' });
    const task = await loadScopedTask(req, res);
    if (!task) return undefined;
    if (['DONE', 'SKIPPED', 'NOT_APPLICABLE'].includes(task.status)) {
      return res.status(409).json({ message: `Task already ${task.status.toLowerCase()}` });
    }
    const out = await prisma.$transaction(async (tx) => {
      const updated = await tx.lifecycleTask.update({
        where: { id: task.id },
        data: {
          status: 'SKIPPED',
          skippedReason: reason,
          completedAt: new Date(),
          completedByUserId: req.user.id,
          version: { increment: 1 },
        },
      });
      const journey = await tx.lifecycleJourney.findUnique({ where: { id: task.journeyId } });
      const advance = await persistAdvance(tx, journey);
      return { task: updated, journey: { id: journey.id, ...advance } };
    });
    res.json(out);
  } catch (e) { next(e); }
}

// POST /journeys/:id/advance — re-run the engine + persist. Blocked (409) if the
// current stage still has open blocking tasks (the engine reports no progress).
async function advanceJourneyEndpoint(req, res, next) {
  try {
    const { businessId } = req.user;
    const journey = await prisma.lifecycleJourney.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
    });
    if (!journey) return res.status(404).json({ message: 'Journey not found' });
    if (req.scope && req.scope.kind !== 'ALL') {
      if (!journey.employeeId || !scopeAllows(req.scope, journey.employeeId)) {
        return res.status(404).json({ message: 'Journey not found' });
      }
    }

    const tasks = await prisma.lifecycleTask.findMany({ where: { journeyId: journey.id } });
    // Guard: the current stage's blocking+mandatory tasks must be cleared to move.
    const currentBlockersOpen = tasks.some(
      (t) => t.stageKey === journey.currentStage && t.isBlocking && t.isMandatory && OPEN_BLOCKING.has(t.status),
    );
    if (currentBlockersOpen) {
      return res.status(409).json({
        message: 'Cannot advance: blocking tasks at the current stage are still open',
        currentStage: journey.currentStage,
      });
    }

    const out = await prisma.$transaction(async (tx) => persistAdvance(tx, journey));
    res.json({ id: journey.id, ...out });
  } catch (e) { next(e); }
}

module.exports = {
  listJourneys,
  getJourney,
  listTasks,
  completeTask,
  skipTask,
  advanceJourney: advanceJourneyEndpoint,
};
