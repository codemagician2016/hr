'use strict';

/**
 * trips.controller.js — Feature 11 operator surface for travel requests (outdoor duty
 * / trips). F1-scoped reads; pre-trip approve/reject via the F10 TRAVEL engine
 * (consumers.travel flips the trip). Bills attach to the trip via
 * ExpenseClaim.travelRequestId on the ESS/claims side.
 */

const prisma = require('../../core/lib/prisma');
const { resolveAccessibleEmployeeIds, scopeWhere, scopeAllows } = require('../lib/scopeResolver');
const engine = require('../approvals/engine');
require('../approvals/consumers.travel'); // self-register TRAVEL callbacks

function paginate(q) {
  const take = Math.min(Math.max(parseInt(q.pageSize, 10) || 25, 1), 100);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  return { take, skip: (page - 1) * take, page };
}

const TRIP_INCLUDE = {
  employee: { select: { id: true, firstName: true, lastName: true, code: true, photoUrl: true } },
  _count: { select: { claims: true } },
};

async function list(req, res, next) {
  try {
    const { businessId } = req.user;
    const scope = await resolveAccessibleEmployeeIds(req.user, 'canViewEmployees');
    if (scope.kind === 'NONE') return res.json({ items: [], total: 0, page: 1, pageSize: 25 });
    const { take, skip, page } = paginate(req.query);
    const where = { businessId, ...scopeWhere(scope, 'employeeId') };
    if (req.query.status) where.status = req.query.status;
    if (req.query.employeeId) where.employeeId = req.query.employeeId;
    const [items, total] = await Promise.all([
      prisma.travelRequest.findMany({ where, include: TRIP_INCLUDE, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.travelRequest.count({ where }),
    ]);
    res.json({ items, total, page, pageSize: take });
  } catch (e) { next(e); }
}

async function get(req, res, next) {
  try {
    const { businessId } = req.user;
    const scope = await resolveAccessibleEmployeeIds(req.user, 'canViewEmployees');
    const trip = await prisma.travelRequest.findFirst({
      where: { id: req.params.id, businessId },
      include: { ...TRIP_INCLUDE, claims: { select: { id: true, claimNumber: true, amount: true, status: true, policyVerdict: true } } },
    });
    if (!trip || !scopeAllows(scope, trip.employeeId)) return res.status(404).json({ message: 'Travel request not found' });
    res.json(trip);
  } catch (e) { next(e); }
}

// Find the OPEN approval request gating this trip.
async function findOpenApprovalRequest(businessId, tripId) {
  return prisma.approvalRequest.findFirst({
    where: { businessId, module: 'TRAVEL', entityType: 'TravelRequest', entityId: tripId, status: { in: ['PENDING', 'ESCALATED'] } },
  });
}

async function decide(req, res, next, { decision }) {
  try {
    const { businessId } = req.user;
    const scope = await resolveAccessibleEmployeeIds(req.user, 'canApproveExpense');
    const trip = await prisma.travelRequest.findFirst({ where: { id: req.params.id, businessId } });
    if (!trip || !scopeAllows(scope, trip.employeeId)) return res.status(404).json({ message: 'Travel request not found' });
    if (trip.status !== 'SUBMITTED') return res.status(409).json({ message: `Trip is ${trip.status}, not actionable` });

    const reason = (req.body && (req.body.reason || req.body.comment || req.body.rejectReason)) || null;
    const open = await findOpenApprovalRequest(businessId, trip.id);
    if (open) {
      if (decision === 'REJECTED' && reason) {
        await prisma.approvalRequest.update({ where: { id: open.id }, data: { payloadJson: { ...(open.payloadJson || {}), rejectReason: reason } } });
      }
      const result = await engine.recordDecision({ approvalRequestId: open.id, actorUserId: req.user.id, decision, comment: reason });
      const updated = await prisma.travelRequest.findUnique({ where: { id: trip.id } });
      return res.json({ ...updated, terminal: result.terminal });
    }
    // Legacy fallback
    const target = decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
    const flip = await prisma.travelRequest.updateMany({
      where: { id: trip.id, status: 'SUBMITTED', version: trip.version },
      data: { status: target, decidedAt: new Date(), decidedBy: req.user.id, ...(decision === 'REJECTED' ? { rejectReason: reason } : {}) },
    });
    if (flip.count === 0) return res.status(409).json({ message: 'Trip changed concurrently' });
    res.json(await prisma.travelRequest.findUnique({ where: { id: trip.id } }));
  } catch (e) {
    if (e && (e.statusCode || (engine.isConcurrencyError && engine.isConcurrencyError(e)))) {
      return res.status(e.statusCode || 409).json({ message: e.message, code: e.code });
    }
    next(e);
  }
}

function approve(req, res, next) { return decide(req, res, next, { decision: 'APPROVED' }); }
function reject(req, res, next) { return decide(req, res, next, { decision: 'REJECTED' }); }

module.exports = { list, get, approve, reject, findOpenApprovalRequest };
