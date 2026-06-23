'use strict';
// Performance controller — Feature 8. Three concerns, one tenant boundary
// (req.user.businessId), now F1-data-scoped + optimistic-locked + SoD-bound:
//   (a) ReviewCycle config/CRUD + bulk launch + release (canManagePerformanceCycle).
//   (b) PerformanceReview (= ReviewInstance) lifecycle via the pure state machine
//       (self → manager → calibrate → signOff → acknowledge → close), with the F1
//       scope ANDed into every read, reviewer≠reviewee SoD on the acting steps,
//       optimistic version on every mutation, and a release gate that keeps a
//       calibrated rating invisible to the subject until releasedAt is set.
//   (c) Goal CRUD (flat path) — scoped + version-checked.
//
// BUGFIXES vs the shipped CRUD (spec §1, §5.4):
//   #1 no scope on any route        → scopeWhere/scopeAllows ANDed everywhere.
//   #2 dead version columns         → read+check+increment on every mutation (409).
//   #3a submitMgr skipped self gate → state machine enforces self-required order.
//   #3b no SoD                      → APPROVAL_ACTIONS + actor-identity guards.
//   #3c calibrate leaked pre-release→ signOff sets releasedAt; serializer hides it.
const prisma = require('../../../core/lib/prisma');
const { scopeWhere, scopeAllows, resolveAccessibleEmployeeIds } = require('../../lib/scopeResolver');
const { effectivePermissions } = require('../../../core/lib/rbac');
const { ROLES } = require('../../../core/lib/roles');
const { writeAudit } = require('../../../core/lib/audit');
const { evaluate } = require('../performance/reviewStateMachine');
const { emitMeritRecommendation } = require('../performance/meritHandoff');
const { computeProrationFactor } = require('../performance/proration');
const { num } = require('../performance/goalRollup');
const { serializeReviewInstance } = require('../performance/serializers');

const DUP_MSG = 'A record with that code already exists';
const STALE_MSG = 'This record was updated elsewhere — reload and try again';

function picker(fields, dates = []) {
  return (body) => {
    const out = {};
    for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
    for (const d of dates) if (out[d] != null) out[d] = new Date(out[d]);
    return out;
  };
}

// Optimistic-lock update: WHERE id AND version=expected, version++. Returns the
// updated row, or null when nothing matched (stale version / concurrent write).
async function lockedUpdate(tx, model, id, expectedVersion, data) {
  const res = await tx[model].updateMany({
    where: { id, version: expectedVersion },
    data: { ...data, version: { increment: 1 } },
  });
  if (res.count === 0) return null;
  return tx[model].findUnique({ where: { id } });
}

// Resolve the acting employee's id (set by attachSelfEmployee). Acting steps are
// keyed on THIS, never on a body-supplied id.
function actorEmployeeId(req) {
  return req.user && req.user.employeeId ? req.user.employeeId : null;
}
function hasPerm(req, key) {
  if (req.user && req.user.role === ROLES.SUPER_ADMIN) return true;
  const perms = effectivePermissions(req.user) || {};
  return !!perms[key];
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) REVIEW CYCLE — CRUD + launch + release (canManagePerformanceCycle)
// ─────────────────────────────────────────────────────────────────────────────
const CYCLE_FIELDS = [
  'entityId', 'code', 'name', 'type', 'periodStart', 'periodEnd', 'status',
  'ratingScaleJson', 'templateId', 'ratingScaleId', 'goalWeightPct',
  'competencyWeightPct', 'meritMatrixJson', 'hrReviewerEmployeeId',
];
const CYCLE_DATES = ['periodStart', 'periodEnd'];
const pickCycle = picker(CYCLE_FIELDS, CYCLE_DATES);

async function listCycles(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId };
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.reviewCycle.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({ items });
  } catch (e) { next(e); }
}

async function getCycle(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.reviewCycle.findFirst({ where: { id: req.params.id, businessId } });
    if (!item) return res.status(404).json({ message: 'Not found' });
    res.json(item);
  } catch (e) { next(e); }
}

async function createCycle(req, res, next) {
  try {
    const { businessId } = req.user;
    for (const r of ['code', 'name', 'type', 'periodStart', 'periodEnd', 'ratingScaleJson']) {
      if (req.body[r] === undefined || req.body[r] === null || req.body[r] === '') {
        return res.status(400).json({ message: `${r} is required` });
      }
    }
    const item = await prisma.reviewCycle.create({ data: { ...pickCycle(req.body), businessId } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'cycle.create', entityType: 'ReviewCycle', entityId: item.id, meta: { code: item.code } });
    res.status(201).json(item);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: DUP_MSG }); next(e); }
}

async function updateCycle(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.reviewCycle.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    const expected = req.body.version !== undefined ? Number(req.body.version) : existing.version;
    const updated = await lockedUpdate(prisma, 'reviewCycle', existing.id, expected, pickCycle(req.body));
    if (!updated) return res.status(409).json({ message: STALE_MSG });
    res.json(updated);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: DUP_MSG }); next(e); }
}

async function removeCycle(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.reviewCycle.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    await prisma.reviewCycle.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// POST /cycles/:id/launch — bulk-mint one ReviewInstance per eligible employee,
// auto-assigning reviewerId = managerEmployeeId, snapshot-on-freeze + pro-ration.
// Idempotent (skips employees who already have an instance) and reports skips.
async function launchCycle(req, res, next) {
  try {
    const { businessId } = req.user;
    const cycle = await prisma.reviewCycle.findFirst({ where: { id: req.params.id, businessId } });
    if (!cycle) return res.status(404).json({ message: 'Not found' });

    const employees = await prisma.employee.findMany({
      where: { businessId, deletedAt: null, isActive: true },
      select: { id: true, managerEmployeeId: true, hireDate: true, status: true },
    });
    const existing = await prisma.performanceReview.findMany({
      where: { businessId, reviewCycleId: cycle.id },
      select: { employeeId: true },
    });
    const have = new Set(existing.map((r) => r.employeeId));

    const created = [];
    const skipped = [];
    for (const emp of employees) {
      if (have.has(emp.id)) { skipped.push({ employeeId: emp.id, reason: 'already_minted' }); continue; }
      // SoD/top-of-tree: reviewer defaults to manager; if none (or self), fall back
      // to the cycle's HR-designated reviewer; if still none, skip (no_manager).
      let reviewerId = emp.managerEmployeeId;
      if (!reviewerId || reviewerId === emp.id) reviewerId = cycle.hrReviewerEmployeeId || null;
      if (!reviewerId || reviewerId === emp.id) { skipped.push({ employeeId: emp.id, reason: 'no_manager' }); continue; }

      const { factor, deferred } = computeProrationFactor({
        periodStart: cycle.periodStart, periodEnd: cycle.periodEnd, hireDate: emp.hireDate,
      });
      if (deferred) { skipped.push({ employeeId: emp.id, reason: 'hired_after_cycle' }); continue; }

      try {
        const row = await prisma.performanceReview.create({
          data: {
            businessId, reviewCycleId: cycle.id, employeeId: emp.id, reviewerId,
            status: 'NOT_STARTED',
            proRationFactor: factor,
            subjectSnapshot: { managerId: reviewerId, hireDate: emp.hireDate || null, frozenAt: new Date().toISOString() },
          },
        });
        created.push(row.id);
      } catch (err) {
        if (err.code === 'P2002') { skipped.push({ employeeId: emp.id, reason: 'already_minted' }); continue; }
        throw err;
      }
    }
    await writeAudit({ businessId, actorId: req.user.id, action: 'cycle.launch', entityType: 'ReviewCycle', entityId: cycle.id, meta: { created: created.length, skipped: skipped.length } });
    res.json({ created: created.length, skipped });
  } catch (e) { next(e); }
}

// POST /cycles/:id/release — org-wide release: stamp releasedAt on the cycle AND
// every CALIBRATED instance (the release gate flips here). Idempotent.
async function releaseCycle(req, res, next) {
  try {
    const { businessId } = req.user;
    const cycle = await prisma.reviewCycle.findFirst({ where: { id: req.params.id, businessId } });
    if (!cycle) return res.status(404).json({ message: 'Not found' });
    const now = new Date();
    const releasedInstances = await prisma.$transaction(async (tx) => {
      if (!cycle.releasedAt) {
        await tx.reviewCycle.update({ where: { id: cycle.id }, data: { releasedAt: now } });
      }
      const r = await tx.performanceReview.updateMany({
        where: { businessId, reviewCycleId: cycle.id, status: 'CALIBRATED', releasedAt: null },
        data: { releasedAt: now },
      });
      return r.count;
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'cycle.release', entityType: 'ReviewCycle', entityId: cycle.id, meta: { releasedInstances } });
    res.json({ releasedAt: now, releasedInstances });
  } catch (e) { next(e); }
}

// GET /cycles/:id/stats — single-query completion roll-up (not N+1).
async function cycleStats(req, res, next) {
  try {
    const { businessId } = req.user;
    const cycle = await prisma.reviewCycle.findFirst({ where: { id: req.params.id, businessId }, select: { id: true, releasedAt: true } });
    if (!cycle) return res.status(404).json({ message: 'Not found' });
    const grouped = await prisma.performanceReview.groupBy({
      by: ['status'], where: { businessId, reviewCycleId: cycle.id }, _count: { _all: true },
    });
    const byStatus = {};
    let total = 0;
    for (const g of grouped) { byStatus[g.status] = g._count._all; total += g._count._all; }
    res.json({ total, byStatus, releasedAt: cycle.releasedAt });
  } catch (e) { next(e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) PERFORMANCE REVIEW — scoped lifecycle (state machine + version + SoD)
// ─────────────────────────────────────────────────────────────────────────────

// Compute the viewer relationship for confidentiality serialization.
function viewerFor(req, instance) {
  const me = actorEmployeeId(req);
  if (hasPerm(req, 'canManagePerformanceCycle')) return 'HR';
  if (me && instance.employeeId === me) return 'SELF';
  if (me && instance.reviewerId === me) return 'MANAGER';
  return 'OTHER';
}

async function listReviews(req, res, next) {
  try {
    const { businessId } = req.user;
    // F1 scope: a manager sees only their reporting sub-tree (subjects); employee
    // self-only. ANDed onto the tenant wall. req.scope set by withEmployeeScope.
    const where = { businessId, ...scopeWhere(req.scope, 'employeeId') };
    if (req.query.reviewCycleId) where.reviewCycleId = req.query.reviewCycleId;
    if (req.query.status) where.status = req.query.status;
    // reviewerId=me is SERVER-derived, never query-trusted.
    if (req.query.reviewerId === 'me') where.reviewerId = actorEmployeeId(req);
    const items = await prisma.performanceReview.findMany({ where, orderBy: { createdAt: 'desc' } });
    const me = actorEmployeeId(req);
    const viewerIsHr = hasPerm(req, 'canManagePerformanceCycle');
    res.json({ items: items.map((it) => serializeReviewInstance(it, viewerIsHr ? 'HR' : (it.employeeId === me ? 'SELF' : 'MANAGER'))) });
  } catch (e) { next(e); }
}

// GET /reviews/:id — scope is keyed on the SUBJECT employeeId, not the review id.
async function getReview(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.performanceReview.findFirst({ where: { id: req.params.id, businessId } });
    if (!item) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllows(req.scope, item.employeeId)) return res.status(404).json({ message: 'Not found' });
    res.json(serializeReviewInstance(item, viewerFor(req, item)));
  } catch (e) { next(e); }
}

// POST /reviews — open a single instance (one-at-a-time; launch is the bulk path).
// SoD: reviewer ≠ reviewee enforced here (createReview let self-review-of-self slip).
async function createReview(req, res, next) {
  try {
    const { businessId } = req.user;
    const { reviewCycleId, employeeId, reviewerId } = req.body;
    if (!reviewCycleId || !employeeId || !reviewerId) {
      return res.status(400).json({ message: 'reviewCycleId, employeeId and reviewerId are required' });
    }
    if (employeeId === reviewerId) {
      return res.status(422).json({ message: 'SoD: reviewer and reviewee must differ' });
    }
    const cycle = await prisma.reviewCycle.findFirst({ where: { id: reviewCycleId, businessId }, select: { id: true } });
    if (!cycle) return res.status(404).json({ message: 'Review cycle not found' });
    const employee = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null }, select: { id: true, managerEmployeeId: true, hireDate: true } });
    if (!employee) return res.status(404).json({ message: 'Employee (reviewee) not found' });
    const reviewer = await prisma.employee.findFirst({ where: { id: reviewerId, businessId, deletedAt: null }, select: { id: true } });
    if (!reviewer) return res.status(404).json({ message: 'Reviewer not found' });

    const item = await prisma.performanceReview.create({
      data: {
        businessId, reviewCycleId, employeeId, reviewerId, status: 'NOT_STARTED',
        subjectSnapshot: { managerId: reviewerId, hireDate: employee.hireDate || null, frozenAt: new Date().toISOString() },
      },
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'review.open', entityType: 'PerformanceReview', entityId: item.id, meta: { employeeId, reviewerId } });
    res.status(201).json(item);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: 'A review already exists for this employee in this cycle' }); next(e); }
}

// Load an instance the actor is allowed to act on, returning {instance,cycle,isHr}
// or a res-sent error. `scopeAction` controls SoD (APPROVAL_ACTIONS subtracts self).
async function loadActable(req, res, scopeAction) {
  const { businessId } = req.user;
  const instance = await prisma.performanceReview.findFirst({ where: { id: req.params.id, businessId } });
  if (!instance) { res.status(404).json({ message: 'Not found' }); return null; }
  const isHr = hasPerm(req, 'canManagePerformanceCycle');
  // HR (canManagePerformanceCycle) bypasses the team band but is still tenant-bound.
  // For everyone else, re-resolve the scope for the SoD-bearing action (which
  // subtracts self for the review.* actions) and require the subject in scope.
  if (!isHr) {
    const scope = await resolveAccessibleEmployeeIds(req.user, scopeAction);
    if (!scopeAllows(scope, instance.employeeId)) { res.status(404).json({ message: 'Not found' }); return null; }
  }
  const cycle = await prisma.reviewCycle.findFirst({ where: { id: instance.reviewCycleId, businessId } });
  return { instance, cycle, isHr };
}

// Build the state-machine ctx from the loaded instance + actor + cycle.
async function buildCtx(req, instance, cycle, isHr) {
  const me = actorEmployeeId(req);
  // skip-level = actor is the reviewer's manager.
  let isSkipLevel = false;
  if (me && instance.reviewerId) {
    const reviewer = await prisma.employee.findFirst({ where: { id: instance.reviewerId, businessId: req.user.businessId }, select: { managerEmployeeId: true } });
    isSkipLevel = !!(reviewer && reviewer.managerEmployeeId === me);
  }
  const scale = (cycle && cycle.ratingScaleJson) || {};
  return {
    actorEmployeeId: me,
    subjectEmployeeId: instance.employeeId,
    reviewerEmployeeId: instance.reviewerId,
    selfRequired: scale.selfRequired !== false,
    isHr,
    isSkipLevel: isSkipLevel || isHr,
    released: !!instance.releasedAt,
    cycleStatus: cycle && cycle.status,
    separationTriggered: !!req.body.separationTriggered,
  };
}

// Generic transition runner: evaluate → optimistic-locked update → audit.
async function runTransition(req, res, next, { event, scopeAction, mutate }) {
  try {
    const loaded = await loadActable(req, res, scopeAction);
    if (!loaded) return undefined;
    const { instance, cycle, isHr } = loaded;
    const ctx = await buildCtx(req, instance, cycle, isHr);
    const verdict = evaluate(event, instance.status, ctx);
    if (!verdict.ok) return res.status(verdict.code).json({ message: verdict.message });

    const expected = req.body.version !== undefined ? Number(req.body.version) : instance.version;
    const out = await prisma.$transaction(async (tx) => {
      const data = await mutate({ req, instance, cycle, ctx, verdict, tx });
      const updated = await lockedUpdate(tx, 'performanceReview', instance.id, expected, data);
      if (!updated) return { stale: true };
      await writeAudit({
        businessId: req.user.businessId, actorId: req.user.id,
        action: 'review.transition', entityType: 'PerformanceReview', entityId: instance.id,
        meta: { event, from: instance.status, to: data.status || updated.status, actorId: req.user.id },
      });
      return { updated };
    });
    if (out.stale) return res.status(409).json({ message: STALE_MSG });
    return res.json(serializeReviewInstance(out.updated, viewerFor(req, out.updated)));
  } catch (e) { return next(e); }
}

// POST /reviews/:id/self — subject submits self rating + comments.
function submitSelfReview(req, res, next) {
  return runTransition(req, res, next, {
    event: 'submitSelf', scopeAction: 'canViewTeamPerformance',
    mutate: async ({ req: r, verdict }) => {
      const data = { status: verdict.to, submittedAt: new Date() };
      if (r.body.selfRating !== undefined) data.selfRating = r.body.selfRating;
      if (r.body.selfComments !== undefined) data.selfComments = r.body.selfComments;
      return data;
    },
  });
}

// POST /reviews/:id/manager — reviewer (≠ subject) submits rating + comments.
function submitManagerReview(req, res, next) {
  return runTransition(req, res, next, {
    event: 'submitMgr', scopeAction: 'review.submitMgr', // SoD: subtracts self
    mutate: async ({ req: r, verdict }) => {
      const data = { status: verdict.to, submittedAt: new Date() };
      if (r.body.managerRating !== undefined) data.managerRating = r.body.managerRating;
      if (r.body.managerComments !== undefined) data.managerComments = r.body.managerComments;
      return data;
    },
  });
}

// POST /reviews/:id/calibrate — HR/skip-level set calibratedRating (NOT finalRating;
// finalRating + release happen at signOff). Writes a CalibrationAdjustment ledger row.
function calibrateReview(req, res, next) {
  return runTransition(req, res, next, {
    event: 'calibrate', scopeAction: 'review.calibrate',
    mutate: async ({ req: r, instance, tx }) => {
      const data = { status: 'CALIBRATED' };
      if (r.body.calibratedRating !== undefined) {
        data.calibratedRating = r.body.calibratedRating;
        // Append-only ledger; never clobbers self/manager ratings.
        const session = r.body.sessionId
          ? await tx.calibrationSession.findFirst({ where: { id: r.body.sessionId, businessId: instance.businessId }, select: { id: true } })
          : null;
        if (session) {
          await tx.calibrationAdjustment.create({
            data: {
              businessId: instance.businessId, sessionId: session.id, reviewInstanceId: instance.id,
              fromRating: instance.calibratedRating != null ? instance.calibratedRating : instance.managerRating,
              toRating: r.body.calibratedRating,
              reason: r.body.reason || 'calibration adjustment',
              byEmployeeId: actorEmployeeId(r) || 'unknown',
            },
          });
        }
      }
      if (r.body.outcomeJson !== undefined) data.outcomeJson = r.body.outcomeJson;
      return data;
    },
  });
}

// POST /reviews/:id/sign-off — lock finalRating, compute compositeScore×proRation,
// set meritEligible + releasedAt (the release gate flips for THIS instance here).
function signOffReview(req, res, next) {
  return runTransition(req, res, next, {
    event: 'signOff', scopeAction: 'review.signOff',
    mutate: async ({ req: r, instance, cycle }) => {
      const finalRating = r.body.finalRating !== undefined ? r.body.finalRating
        : (instance.calibratedRating != null ? instance.calibratedRating : instance.managerRating);
      const goalW = num(cycle && cycle.goalWeightPct) || 50;
      const compW = num(cycle && cycle.competencyWeightPct) || 50;
      const base = num(finalRating);
      const composite = Math.round((base * (goalW + compW) / 100) * num(instance.proRationFactor) * 1000) / 1000;
      return {
        finalRating,
        compositeScore: composite,
        meritEligible: r.body.meritEligible !== undefined ? !!r.body.meritEligible : true,
        releasedAt: new Date(),
        status: 'CALIBRATED', // stays CALIBRATED (locked); release is the visible change
      };
    },
  });
}

// POST /reviews/:id/acknowledge — subject acknowledges (only when released).
function acknowledgeReview(req, res, next) {
  return runTransition(req, res, next, {
    event: 'acknowledge', scopeAction: 'canViewTeamPerformance',
    mutate: async ({ req: r }) => {
      const data = { status: 'ACKNOWLEDGED', acknowledgedAt: new Date() };
      if (r.body.rebuttalNote !== undefined) data.rebuttalNote = r.body.rebuttalNote;
      return data;
    },
  });
}

// POST /reviews/:id/close — HR closes; emits the merit recommendation (loose F5 hook).
function closeReview(req, res, next) {
  return runTransition(req, res, next, {
    event: 'close', scopeAction: 'review.signOff',
    mutate: async ({ instance, cycle, tx }) => {
      await emitMeritRecommendation(tx, { instance, cycle, actorId: req.user.id });
      return { status: 'CLOSED' };
    },
  });
}

// POST /reviews/:id/reopen — HR reopens (prior ratings preserved as history).
function reopenReview(req, res, next) {
  return runTransition(req, res, next, {
    event: 'reopen', scopeAction: 'review.signOff',
    mutate: async () => ({ status: 'MANAGER_SUBMITTED' }),
  });
}

// POST /reviews/:id/link-compensation — idempotent F5 back-link (requires
// canManageCompensation, checked at the route). Sets linkedCompensationId.
async function linkCompensation(req, res, next) {
  try {
    const { businessId } = req.user;
    const instance = await prisma.performanceReview.findFirst({ where: { id: req.params.id, businessId } });
    if (!instance) return res.status(404).json({ message: 'Not found' });
    const { compensationRevisionId } = req.body;
    if (!compensationRevisionId) return res.status(400).json({ message: 'compensationRevisionId is required' });
    const rev = await prisma.compensationRevision.findFirst({ where: { id: compensationRevisionId, businessId }, select: { id: true } });
    if (!rev) return res.status(404).json({ message: 'CompensationRevision not found' });
    if (instance.linkedCompensationId === compensationRevisionId) return res.json(instance); // idempotent
    const updated = await lockedUpdate(prisma, 'performanceReview', instance.id, instance.version, { linkedCompensationId: compensationRevisionId });
    if (!updated) return res.status(409).json({ message: STALE_MSG });
    await prisma.meritRecommendation.updateMany({
      where: { businessId, reviewInstanceId: instance.id }, data: { compensationRevisionId, status: 'APPLIED' },
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'review.linkCompensation', entityType: 'PerformanceReview', entityId: instance.id, meta: { compensationRevisionId } });
    res.json(updated);
  } catch (e) { next(e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// (c) GOAL — scoped CRUD (flat path), version-checked
// ─────────────────────────────────────────────────────────────────────────────
const GOAL_FIELDS = [
  'employeeId', 'reviewCycleId', 'title', 'description', 'category', 'weight',
  'target', 'progress', 'status', 'dueDate', 'parentGoalId',
];
const GOAL_DATES = ['dueDate'];
const pickGoal = picker(GOAL_FIELDS, GOAL_DATES);

async function listGoals(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId, ...scopeWhere(req.scope, 'employeeId') };
    if (req.query.employeeId && scopeAllows(req.scope, req.query.employeeId)) where.employeeId = req.query.employeeId;
    if (req.query.reviewCycleId) where.reviewCycleId = req.query.reviewCycleId;
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.goal.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({ items });
  } catch (e) { next(e); }
}

async function getGoal(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.goal.findFirst({ where: { id: req.params.id, businessId } });
    if (!item) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllows(req.scope, item.employeeId)) return res.status(404).json({ message: 'Not found' });
    res.json(item);
  } catch (e) { next(e); }
}

async function createGoal(req, res, next) {
  try {
    const { businessId } = req.user;
    for (const r of ['employeeId', 'title']) {
      if (req.body[r] === undefined || req.body[r] === null || req.body[r] === '') {
        return res.status(400).json({ message: `${r} is required` });
      }
    }
    if (!scopeAllows(req.scope, req.body.employeeId)) return res.status(404).json({ message: 'Employee not found' });
    const employee = await prisma.employee.findFirst({ where: { id: req.body.employeeId, businessId, deletedAt: null }, select: { id: true } });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });
    const item = await prisma.goal.create({ data: { ...pickGoal(req.body), businessId } });
    res.status(201).json(item);
  } catch (e) { next(e); }
}

async function updateGoal(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.goal.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllows(req.scope, existing.employeeId)) return res.status(404).json({ message: 'Not found' });
    const expected = req.body.version !== undefined ? Number(req.body.version) : existing.version;
    const data = pickGoal(req.body);
    delete data.employeeId; // never move a goal across employees via update
    const updated = await lockedUpdate(prisma, 'goal', existing.id, expected, data);
    if (!updated) return res.status(409).json({ message: STALE_MSG });
    res.json(updated);
  } catch (e) { next(e); }
}

async function removeGoal(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.goal.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllows(req.scope, existing.employeeId)) return res.status(404).json({ message: 'Not found' });
    await prisma.goal.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
}

module.exports = {
  // review cycles
  listCycles, getCycle, createCycle, updateCycle, removeCycle,
  launchCycle, releaseCycle, cycleStats,
  // performance reviews
  listReviews, getReview, createReview,
  submitSelfReview, submitManagerReview, calibrateReview, signOffReview,
  acknowledgeReview, closeReview, reopenReview, linkCompensation,
  // goals
  listGoals, getGoal, createGoal, updateGoal, removeGoal,
  // exported for tests
  _internals: { lockedUpdate, viewerFor },
};
