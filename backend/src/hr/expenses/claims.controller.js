'use strict';

/**
 * claims.controller.js — Feature 11 operator surface for expense claims.
 *
 * The big correctness fix over the legacy controller: EVERY read/write is F1-SCOPED
 * (resolveAccessibleEmployeeIds + scopeWhere('employeeId')) — out-of-scope ⇒ 404,
 * never a 403 existence leak. Approve/reject/return/reimburse are gated by
 * canApproveExpense (NOT the old canManageEmployees), run through the F10 engine
 * (consumers.expense flips the claim), and enforce maker-checker SoD (the engine's
 * SoD re-check + the scope self-drop).
 *
 * Money stays Prisma Decimal end-to-end.
 */

const prisma = require('../../core/lib/prisma');
const { resolveAccessibleEmployeeIds, scopeWhere, scopeAllows } = require('../lib/scopeResolver');
const engine = require('../approvals/engine');
require('../approvals/consumers.expense'); // self-register EXPENSE callbacks

function paginate(q) {
  const take = Math.min(Math.max(parseInt(q.pageSize, 10) || 25, 1), 100);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  return { take, skip: (page - 1) * take, page };
}

const CLAIM_INCLUDE = {
  employee: { select: { id: true, firstName: true, lastName: true, code: true, photoUrl: true } },
  category: { select: { id: true, name: true } },
  travelRequest: { select: { id: true, travelNumber: true, destCity: true, status: true } },
};

// ── list (scoped) ──────────────────────────────────────────────────────────────
async function list(req, res, next) {
  try {
    const { businessId } = req.user;
    const scope = await resolveAccessibleEmployeeIds(req.user, 'canViewEmployees');
    if (scope.kind === 'NONE') return res.json({ items: [], total: 0, page: 1, pageSize: 25 });
    const { take, skip, page } = paginate(req.query);
    const where = { businessId, deletedAt: null, ...scopeWhere(scope, 'employeeId') };
    if (req.query.status) where.status = req.query.status;
    if (req.query.claimType) where.claimType = req.query.claimType;
    if (req.query.employeeId) where.employeeId = req.query.employeeId;
    if (req.query.policyVerdict) where.policyVerdict = req.query.policyVerdict;
    const [items, total] = await Promise.all([
      prisma.expenseClaim.findMany({ where, include: CLAIM_INCLUDE, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.expenseClaim.count({ where }),
    ]);
    res.json({ items, total, page, pageSize: take });
  } catch (e) { next(e); }
}

// ── get one (scoped → 404 if out of scope) ──────────────────────────────────────
async function get(req, res, next) {
  try {
    const { businessId } = req.user;
    const scope = await resolveAccessibleEmployeeIds(req.user, 'canViewEmployees');
    const claim = await prisma.expenseClaim.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: { ...CLAIM_INCLUDE, lines: { include: { category: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } } },
    });
    if (!claim || !scopeAllows(scope, claim.employeeId)) return res.status(404).json({ message: 'Expense claim not found' });
    res.json(claim);
  } catch (e) { next(e); }
}

// ── approver inbox: claims/trips awaiting THIS actor's decision (scoped) ────────
async function inbox(req, res, next) {
  try {
    const { businessId } = req.user;
    const scope = await resolveAccessibleEmployeeIds(req.user, 'canApproveExpense');
    if (scope.kind === 'NONE') return res.json({ claims: [], trips: [], total: 0 });
    const [claims, trips] = await Promise.all([
      prisma.expenseClaim.findMany({
        where: { businessId, status: 'SUBMITTED', deletedAt: null, ...scopeWhere(scope, 'employeeId') },
        include: CLAIM_INCLUDE, orderBy: { submittedAt: 'desc' }, take: 500,
      }),
      prisma.travelRequest.findMany({
        where: { businessId, status: 'SUBMITTED', ...scopeWhere(scope, 'employeeId') },
        include: { employee: { select: { id: true, firstName: true, lastName: true, code: true } } },
        orderBy: { submittedAt: 'desc' }, take: 500,
      }),
    ]);
    res.json({ claims, trips, total: claims.length + trips.length });
  } catch (e) { next(e); }
}

// Find the OPEN approval-engine request gating this claim.
async function findOpenApprovalRequest(businessId, claimId) {
  return prisma.approvalRequest.findFirst({
    where: { businessId, module: 'EXPENSE', entityType: 'ExpenseClaim', entityId: claimId, status: { in: ['PENDING', 'ESCALATED'] } },
  });
}

// ── shared decision seam (approve / reject / return) ────────────────────────────
// Loads the scoped claim (404 if out of scope), confirms it is SUBMITTED, then drives
// the F10 engine as the acting operator. The engine enforces SoD (actor ≠ requester)
// + current-step membership and fires consumers.expense to flip the claim. A claim
// with no open request (legacy) falls back to a guarded direct flip.
async function decide(req, res, next, { decision }) {
  try {
    const { businessId } = req.user;
    const scope = await resolveAccessibleEmployeeIds(req.user, 'canApproveExpense');
    const claim = await prisma.expenseClaim.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!claim || !scopeAllows(scope, claim.employeeId)) return res.status(404).json({ message: 'Expense claim not found' });
    if (claim.status !== 'SUBMITTED') return res.status(409).json({ message: `Claim is ${claim.status}, not actionable` });

    const reason = (req.body && (req.body.reason || req.body.comment || req.body.rejectReason)) || null;
    const open = await findOpenApprovalRequest(businessId, claim.id);
    if (open) {
      const actorUserId = req.user.id;
      if (decision === 'REJECTED' && reason) {
        await prisma.approvalRequest.update({ where: { id: open.id }, data: { payloadJson: { ...(open.payloadJson || {}), rejectReason: reason } } });
      }
      const result = await engine.recordDecision({ approvalRequestId: open.id, actorUserId, decision, comment: reason });
      const updated = await prisma.expenseClaim.findUnique({ where: { id: claim.id } });
      return res.json({ ...updated, terminal: result.terminal, changesRequested: !!result.changesRequested });
    }

    // Legacy fallback (no engine request): a guarded direct flip with SoD via scope.
    const target = decision === 'APPROVED' ? 'APPROVED' : decision === 'REJECTED' ? 'REJECTED' : 'DRAFT';
    const flip = await prisma.expenseClaim.updateMany({
      where: { id: claim.id, status: 'SUBMITTED', version: claim.version },
      data: { status: target, decidedAt: new Date(), decidedBy: req.user.id, ...(decision === 'REJECTED' ? { rejectReason: reason } : {}) },
    });
    if (flip.count === 0) return res.status(409).json({ message: 'Claim changed concurrently' });
    res.json(await prisma.expenseClaim.findUnique({ where: { id: claim.id } }));
  } catch (e) {
    if (e && (e.statusCode || (engine.isConcurrencyError && engine.isConcurrencyError(e)))) {
      return res.status(e.statusCode || 409).json({ message: e.message, code: e.code });
    }
    next(e);
  }
}

function approve(req, res, next) { return decide(req, res, next, { decision: 'APPROVED' }); }
function reject(req, res, next) { return decide(req, res, next, { decision: 'REJECTED' }); }
function returnForChanges(req, res, next) { return decide(req, res, next, { decision: 'REQUESTED_CHANGES' }); }

// ── reimburse (Finance settle: APPROVED → REIMBURSED, paymentRef / payRunId) ────
async function reimburse(req, res, next) {
  try {
    const { businessId } = req.user;
    const scope = await resolveAccessibleEmployeeIds(req.user, 'canApproveExpense');
    const claim = await prisma.expenseClaim.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!claim || !scopeAllows(scope, claim.employeeId)) return res.status(404).json({ message: 'Expense claim not found' });
    if (claim.status !== 'APPROVED') return res.status(409).json({ message: `Claim is ${claim.status}, only APPROVED claims can be reimbursed` });
    const flip = await prisma.expenseClaim.updateMany({
      where: { id: claim.id, status: 'APPROVED', version: claim.version },
      data: {
        status: 'REIMBURSED', reimbursedAt: new Date(), reimbursedBy: req.user.id,
        paymentRef: (req.body && req.body.paymentRef) || null,
        payRunId: (req.body && req.body.payRunId) || null,
        version: { increment: 1 },
      },
    });
    if (flip.count === 0) return res.status(409).json({ message: 'Claim changed concurrently' });
    res.json(await prisma.expenseClaim.findUnique({ where: { id: claim.id } }));
  } catch (e) { next(e); }
}

module.exports = { list, get, inbox, approve, reject, returnForChanges, reimburse, findOpenApprovalRequest };
