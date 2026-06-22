'use strict';
// Performance controller. Three concerns, one tenant boundary
// (req.user.businessId), following the org/leave controller conventions:
//   (a) ReviewCycle CRUD (unique per (businessId, code); hard model — no
//       deletedAt, so delete is a real delete guarded by tenant scope).
//   (b) PerformanceReview lifecycle — self/manager review flow over ReviewStatus
//       NOT_STARTED -> SELF_SUBMITTED -> MANAGER_SUBMITTED -> CALIBRATED ->
//       ACKNOWLEDGED -> CLOSED. Ratings are Decimal(4,2).
//   (c) Goal CRUD (employee/org OKRs; progress Decimal, no deletedAt).
const prisma = require('../../../core/lib/prisma');

const DUP_MSG = 'A record with that code already exists';

function picker(fields, dates = []) {
  return (body) => {
    const out = {};
    for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
    for (const d of dates) if (out[d] != null) out[d] = new Date(out[d]);
    return out;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) REVIEW CYCLE — CRUD
// ─────────────────────────────────────────────────────────────────────────────
const CYCLE_FIELDS = [
  'entityId', 'code', 'name', 'type', 'periodStart', 'periodEnd',
  'status', 'ratingScaleJson',
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
    res.status(201).json(item);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: DUP_MSG }); next(e); }
}

async function updateCycle(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.reviewCycle.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    const item = await prisma.reviewCycle.update({ where: { id: req.params.id }, data: pickCycle(req.body) });
    res.json(item);
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

// ─────────────────────────────────────────────────────────────────────────────
// (b) PERFORMANCE REVIEW — self/manager lifecycle
// Unique per (businessId, reviewCycleId, employeeId). Ratings Decimal(4,2).
// ─────────────────────────────────────────────────────────────────────────────

async function listReviews(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId };
    if (req.query.reviewCycleId) where.reviewCycleId = req.query.reviewCycleId;
    if (req.query.employeeId) where.employeeId = req.query.employeeId;
    if (req.query.reviewerId) where.reviewerId = req.query.reviewerId;
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.performanceReview.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({ items });
  } catch (e) { next(e); }
}

async function getReview(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.performanceReview.findFirst({ where: { id: req.params.id, businessId } });
    if (!item) return res.status(404).json({ message: 'Not found' });
    res.json(item);
  } catch (e) { next(e); }
}

// POST /reviews — open a review for (cycle, employee, reviewer). Validates that
// the cycle, reviewee and reviewer all belong to the tenant.
async function createReview(req, res, next) {
  try {
    const { businessId } = req.user;
    const { reviewCycleId, employeeId, reviewerId } = req.body;
    if (!reviewCycleId || !employeeId || !reviewerId) {
      return res.status(400).json({ message: 'reviewCycleId, employeeId and reviewerId are required' });
    }
    const cycle = await prisma.reviewCycle.findFirst({ where: { id: reviewCycleId, businessId }, select: { id: true } });
    if (!cycle) return res.status(404).json({ message: 'Review cycle not found' });
    const employee = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null }, select: { id: true } });
    if (!employee) return res.status(404).json({ message: 'Employee (reviewee) not found' });
    const reviewer = await prisma.employee.findFirst({ where: { id: reviewerId, businessId, deletedAt: null }, select: { id: true } });
    if (!reviewer) return res.status(404).json({ message: 'Reviewer not found' });

    const item = await prisma.performanceReview.create({
      data: { businessId, reviewCycleId, employeeId, reviewerId, status: 'NOT_STARTED' },
    });
    res.status(201).json(item);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: 'A review already exists for this employee in this cycle' }); next(e); }
}

// POST /reviews/:id/self — reviewee submits self-rating + comments.
// NOT_STARTED -> SELF_SUBMITTED.
async function submitSelfReview(req, res, next) {
  try {
    const { businessId } = req.user;
    const review = await prisma.performanceReview.findFirst({ where: { id: req.params.id, businessId } });
    if (!review) return res.status(404).json({ message: 'Not found' });
    if (review.status !== 'NOT_STARTED') {
      return res.status(409).json({ message: `Cannot submit self-review from status ${review.status}` });
    }
    const data = { status: 'SELF_SUBMITTED', submittedAt: new Date() };
    if (req.body.selfRating !== undefined) data.selfRating = req.body.selfRating;
    if (req.body.selfComments !== undefined) data.selfComments = req.body.selfComments;
    const item = await prisma.performanceReview.update({ where: { id: review.id }, data });
    res.json(item);
  } catch (e) { next(e); }
}

// POST /reviews/:id/manager — manager submits rating + comments.
// SELF_SUBMITTED (or NOT_STARTED, if no self-review required) -> MANAGER_SUBMITTED.
async function submitManagerReview(req, res, next) {
  try {
    const { businessId } = req.user;
    const review = await prisma.performanceReview.findFirst({ where: { id: req.params.id, businessId } });
    if (!review) return res.status(404).json({ message: 'Not found' });
    if (!['NOT_STARTED', 'SELF_SUBMITTED'].includes(review.status)) {
      return res.status(409).json({ message: `Cannot submit manager review from status ${review.status}` });
    }
    const data = { status: 'MANAGER_SUBMITTED', submittedAt: new Date() };
    if (req.body.managerRating !== undefined) data.managerRating = req.body.managerRating;
    if (req.body.managerComments !== undefined) data.managerComments = req.body.managerComments;
    const item = await prisma.performanceReview.update({ where: { id: review.id }, data });
    res.json(item);
  } catch (e) { next(e); }
}

// POST /reviews/:id/calibrate — set the final (post-calibration) rating +
// outcome. MANAGER_SUBMITTED -> CALIBRATED.
async function calibrateReview(req, res, next) {
  try {
    const { businessId } = req.user;
    const review = await prisma.performanceReview.findFirst({ where: { id: req.params.id, businessId } });
    if (!review) return res.status(404).json({ message: 'Not found' });
    if (review.status !== 'MANAGER_SUBMITTED') {
      return res.status(409).json({ message: `Cannot calibrate from status ${review.status}` });
    }
    const data = { status: 'CALIBRATED' };
    if (req.body.finalRating !== undefined) data.finalRating = req.body.finalRating;
    if (req.body.outcomeJson !== undefined) data.outcomeJson = req.body.outcomeJson;
    if (req.body.linkedCompensationId !== undefined) data.linkedCompensationId = req.body.linkedCompensationId;
    const item = await prisma.performanceReview.update({ where: { id: review.id }, data });
    res.json(item);
  } catch (e) { next(e); }
}

// POST /reviews/:id/acknowledge — reviewee acknowledges. CALIBRATED -> ACKNOWLEDGED.
async function acknowledgeReview(req, res, next) {
  try {
    const { businessId } = req.user;
    const review = await prisma.performanceReview.findFirst({ where: { id: req.params.id, businessId } });
    if (!review) return res.status(404).json({ message: 'Not found' });
    if (review.status !== 'CALIBRATED') {
      return res.status(409).json({ message: `Cannot acknowledge from status ${review.status}` });
    }
    const item = await prisma.performanceReview.update({ where: { id: review.id }, data: { status: 'ACKNOWLEDGED' } });
    res.json(item);
  } catch (e) { next(e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// (c) GOAL — CRUD
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
    const where = { businessId };
    if (req.query.employeeId) where.employeeId = req.query.employeeId;
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
    const item = await prisma.goal.update({ where: { id: req.params.id }, data: pickGoal(req.body) });
    res.json(item);
  } catch (e) { next(e); }
}

async function removeGoal(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.goal.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    await prisma.goal.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
}

module.exports = {
  // review cycles
  listCycles, getCycle, createCycle, updateCycle, removeCycle,
  // performance reviews
  listReviews, getReview, createReview,
  submitSelfReview, submitManagerReview, calibrateReview, acknowledgeReview,
  // goals
  listGoals, getGoal, createGoal, updateGoal, removeGoal,
};
