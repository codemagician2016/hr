'use strict';
// calibration.controller.js — Feature 8 §5.7: CalibrationSession lifecycle +
// distribution stats. HR + skip-level only (canCalibrateRatings). The session
// groups the ReviewInstances whose subjects roll up to a common skip-level manager
// (TEAM CTE rooted at the skip-level employee). Per-instance adjustments are written
// by the review controller's calibrateReview (append-only CalibrationAdjustment).
const prisma = require('../../../core/lib/prisma');
const { writeAudit } = require('../../../core/lib/audit');
const { resolveAccessibleEmployeeIds } = require('../../lib/scopeResolver');
const { distribution, distributionWarning } = require('../performance/calibration');

const STALE_MSG = 'This record was updated elsewhere — reload and try again';

async function listSessions(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId };
    if (req.query.cycleId) where.cycleId = req.query.cycleId;
    const items = await prisma.calibrationSession.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({ items });
  } catch (e) { next(e); }
}

// POST /calibration/sessions — open a session rooted at a skip-level employee.
async function createSession(req, res, next) {
  try {
    const { businessId } = req.user;
    const { cycleId, skipLevelEmployeeId } = req.body;
    if (!cycleId || !skipLevelEmployeeId) return res.status(400).json({ message: 'cycleId and skipLevelEmployeeId are required' });
    const cycle = await prisma.reviewCycle.findFirst({ where: { id: cycleId, businessId }, select: { id: true } });
    if (!cycle) return res.status(404).json({ message: 'Review cycle not found' });
    const item = await prisma.calibrationSession.create({ data: { businessId, cycleId, skipLevelEmployeeId, status: 'OPEN' } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'calibration.open', entityType: 'CalibrationSession', entityId: item.id, meta: { cycleId, skipLevelEmployeeId } });
    res.status(201).json(item);
  } catch (e) { next(e); }
}

// GET /calibration/sessions/:id/roster — the instances in this skip-level group +
// distribution histogram vs the rating scale's forced-distribution target (warning).
async function sessionRoster(req, res, next) {
  try {
    const { businessId } = req.user;
    const session = await prisma.calibrationSession.findFirst({ where: { id: req.params.id, businessId } });
    if (!session) return res.status(404).json({ message: 'Not found' });
    // Group = TEAM sub-tree rooted at the skip-level employee.
    const scope = await resolveAccessibleEmployeeIds(
      { ...req.user, employeeId: session.skipLevelEmployeeId, businessRole: { defaultScope: 'TEAM' }, role: 'STAFF' },
      'canCalibrateRatings',
    );
    const ids = scope.kind === 'IDS' ? [...scope.ids] : null;
    const where = { businessId, reviewCycleId: session.cycleId };
    if (ids) where.employeeId = { in: ids };
    const instances = await prisma.performanceReview.findMany({
      where, select: { id: true, employeeId: true, selfRating: true, managerRating: true, calibratedRating: true, finalRating: true, status: true },
    });
    const cycle = await prisma.reviewCycle.findFirst({ where: { id: session.cycleId, businessId }, select: { ratingScaleJson: true, ratingScaleId: true } });
    let scalePoints = [];
    let forced = null;
    if (cycle && cycle.ratingScaleId) {
      const scale = await prisma.ratingScale.findFirst({ where: { id: cycle.ratingScaleId, businessId }, select: { pointsJson: true, forcedDistributionJson: true } });
      if (scale) { scalePoints = Array.isArray(scale.pointsJson) ? scale.pointsJson : []; forced = scale.forcedDistributionJson; }
    } else if (cycle && Array.isArray(cycle.ratingScaleJson)) {
      scalePoints = cycle.ratingScaleJson;
    } else if (cycle && cycle.ratingScaleJson && Array.isArray(cycle.ratingScaleJson.points)) {
      scalePoints = cycle.ratingScaleJson.points;
      forced = cycle.ratingScaleJson.forcedDistribution || null;
    }
    const dist = distribution(instances, scalePoints);
    const warning = distributionWarning(dist, forced);
    res.json({ session, instances, distribution: dist, warning });
  } catch (e) { next(e); }
}

// PATCH /calibration/sessions/:id — lock/close the session (state guard + version).
async function updateSession(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.calibrationSession.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    const expected = req.body.version !== undefined ? Number(req.body.version) : existing.version;
    const data = {};
    if (req.body.status !== undefined) data.status = req.body.status;
    const r = await prisma.calibrationSession.updateMany({ where: { id: existing.id, version: expected }, data: { ...data, version: { increment: 1 } } });
    if (r.count === 0) return res.status(409).json({ message: STALE_MSG });
    const updated = await prisma.calibrationSession.findUnique({ where: { id: existing.id } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'calibration.update', entityType: 'CalibrationSession', entityId: existing.id, meta: { status: updated.status } });
    res.json(updated);
  } catch (e) { next(e); }
}

module.exports = { listSessions, createSession, sessionRoster, updateSession };
