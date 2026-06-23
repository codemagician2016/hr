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
const { scopeAllows } = require('../../lib/scopeResolver');
const { advanceJourney } = require('../journeyEngine');
const {
  provisionEmployee, confirmProbation, resolveSodSubjectUserIds, ProvisionError,
} = require('../provision');

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

// GET /tasks?owner=me|all — task list, scoped per owner mode:
//   owner=me  -> ASSIGNEE-based: tasks assigned to the actor themselves (the
//                manager's own personal task list — by Employee or User id).
//   owner=all -> SUBJECT-based: tasks whose JOURNEY SUBJECT (the new hire) is in
//                the actor's reporting sub-tree, so a manager sees ALL tasks for
//                their sub-tree's hires (incl. HR/IT-owned ones), not only those
//                that happen to be assigned to an in-scope employee. HR (ALL band)
//                sees the whole tenant. (M: the old code scoped owner=all by
//                ASSIGNEE, which hid sub-tree hires' tasks owned by other functions
//                and leaked unrelated tasks merely assigned to a sub-tree employee.)
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
      // owner=all → scope by the JOURNEY SUBJECT employee (the new hire). The
      // tenant wall is already on `where.businessId`; we AND the subject filter
      // onto the related journey so only the actor's sub-tree's hires are listed.
      const subjectScope = journeyScopeWhere(req.scope);
      // journeyScopeWhere returns {} for ALL, { id:{in:[]} } for NONE, or
      // { employeeId:{in:[...]} } for IDS. Apply it to the related journey.
      where.journey = { ...where.journey, ...subjectScope };
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
// Scope is enforced by loadScopedJourney (the journey's SUBJECT employee), so the
// route does NOT pass { idParam } — a journeyId is never in the employee scope-set
// (that bug 404'd every manager).
async function advanceJourneyEndpoint(req, res, next) {
  try {
    const journey = await loadScopedJourney(req, res);
    if (!journey) return undefined;

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

// Load a journey for an HR pipeline action + enforce subject-scope. Returns the
// journey or sends a 404 (and returns null). A pre-provision journey (no
// employeeId yet) is HR-only (ALL band) — a manager has no hierarchy anchor to a
// not-yet-hired person, so out-of-scope resolves to 404 (IDOR-safe, never 403).
async function loadScopedJourney(req, res) {
  const { businessId } = req.user;
  const journey = await prisma.lifecycleJourney.findFirst({
    where: { id: req.params.id, businessId, deletedAt: null },
  });
  if (!journey) {
    res.status(404).json({ message: 'Journey not found' });
    return null;
  }
  if (req.scope && req.scope.kind !== 'ALL') {
    if (!journey.employeeId || !scopeAllows(req.scope, journey.employeeId)) {
      res.status(404).json({ message: 'Journey not found' });
      return null;
    }
  }
  return journey;
}

// POST /journeys/:id/provision — atomically provision the employee (Feature 4
// §4.2, slice 4c). requirePermission('canManageOnboarding') + scope guard on the
// route; SoD here: the provisioner must NOT be the offer's approver (if the offer
// went through an approval gate). On 409 'already-provisioned' returns the linked
// employeeId; on a genuine failure the tx is rolled back and the journey BLOCKED.
async function provisionJourney(req, res, next) {
  try {
    const journey = await loadScopedJourney(req, res);
    if (!journey) return undefined;

    // ── SoD (spec §7/§8, M1): the provisioner must NOT be a user with a stake in
    //    the offer. resolveSodSubjectUserIds derives this from signals that EXIST
    //    in production — the offer's APPROVED approver (when there's an approval
    //    gate) AND the requisition's hiring manager (Job.hiringManagerId → portal
    //    User), so the guard's precondition is actually reachable in prod (the
    //    old approvalRequestId-only path was never set and so was dead). ──
    if (journey.offerId) {
      const offer = await prisma.offer.findFirst({
        where: { id: journey.offerId, businessId: req.user.businessId },
      });
      if (offer) {
        const sodSubjects = await resolveSodSubjectUserIds(prisma, offer);
        if (sodSubjects.has(req.user.id)) {
          return res.status(403).json({
            message: 'Separation of duties: a user with a stake in this offer (its approver or the requisition recruiter) cannot provision the hire',
            reason: 'sod-provision-vs-approve',
          });
        }
      }
    }

    const out = await provisionEmployee({ journeyId: journey.id, actorId: req.user.id }, prisma);
    return res.status(201).json({
      employee: {
        id: out.employee.id, code: out.employee.code, status: out.employee.status,
        userId: out.employee.userId,
        currentEmploymentRecordId: out.employee.currentEmploymentRecordId,
        currentCompensationId: out.employee.currentCompensationId,
        managerEmployeeId: out.employee.managerEmployeeId,
      },
      journey: out.journey,
      provisioned: out.resultJson,
    });
  } catch (e) {
    if (e instanceof ProvisionError) {
      return res.status(e.status || 422).json({
        message: e.message,
        reason: e.reason,
        ...(e.employeeId ? { employeeId: e.employeeId } : {}),
      });
    }
    return next(e);
  }
}

// POST /journeys/:id/confirm-probation — confirm the hire's probation (Feature 4
// §4.2). EmploymentRecord(PROBATION_CONFIRM), Employee.status → ACTIVE, advance
// PROBATION → COMPLETED. Scoped to the journey's subject employee.
async function confirmProbationEndpoint(req, res, next) {
  try {
    const journey = await loadScopedJourney(req, res);
    if (!journey) return undefined;
    if (!journey.employeeId) {
      return res.status(422).json({ message: 'Journey has no provisioned employee to confirm', reason: 'precondition' });
    }
    const out = await confirmProbation({ employeeId: journey.employeeId, actorId: req.user.id }, prisma);
    return res.json({
      employee: { id: out.employee.id, status: out.employee.status },
      changed: out.changed,
    });
  } catch (e) {
    if (e instanceof ProvisionError) {
      return res.status(e.status || 422).json({ message: e.message, reason: e.reason });
    }
    return next(e);
  }
}

module.exports = {
  listJourneys,
  getJourney,
  listTasks,
  completeTask,
  skipTask,
  advanceJourney: advanceJourneyEndpoint,
  provisionJourney,
  confirmProbation: confirmProbationEndpoint,
};
