'use strict';
// Expense reimbursement. Employees raise an ExpenseClaim against an
// ExpenseCategory; it walks a DRAFT → SUBMITTED → APPROVED/REJECTED → REIMBURSED
// state machine (CANCELLED is the requester's withdraw path). Every query is
// tenant-scoped by req.user.businessId; reads filter deletedAt: null; money
// (amount) is a Prisma Decimal and is passed through untouched (never parsed).
// Approve/reject/reimburse are gated by canManageEmployees at the route layer.
const prisma = require('../../core/lib/prisma');
// Feature 10 slice 10c — expense approval now routes through the configurable
// approval-workflow engine. `submit` opens an engine request (BUILT_IN_DEFAULT
// EXPENSE chain = manager → HR over threshold; small claims stay manager-only via a
// conditional-skip step); approve/reject/cancel drive the engine, which fires the
// EXPENSE consumer (flips ExpenseClaim.status + stamps decidedBy/decidedAt). A claim
// with no open engine request (submitted before 10c) falls back to the legacy direct
// flip, so behaviour is preserved either way.
const engine = require('../approvals/engine');
// Requiring the consumer self-registers the EXPENSE callback bundle (idempotent), so
// loading this controller alone (tests/scripts/API) wires onApprove/onReject/onCancel.
require('../approvals/consumers.expense');

// ── Categories (reference data) ──────────────────────────────────────────────
const CATEGORY_FIELDS = ['code', 'name', 'glCode', 'isActive'];

function pickCategory(body) {
  const out = {};
  for (const f of CATEGORY_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

// ── Claims ───────────────────────────────────────────────────────────────────
// Allow-list of fields a requester may set on create/update (status & all
// workflow stamps are driven only by the action endpoints, never the body).
const CLAIM_FIELDS = ['employeeId', 'categoryId', 'claimNumber', 'amount', 'currencyCode', 'description', 'receiptUrl', 'expenseDate'];
const CLAIM_DATE_FIELDS = ['expenseDate'];

function pickClaim(body) {
  const out = {};
  for (const f of CLAIM_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  for (const d of CLAIM_DATE_FIELDS) if (out[d] != null) out[d] = new Date(out[d]);
  return out;
}

// Allowed status transitions for the claim state machine.
const TRANSITIONS = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['REIMBURSED', 'REJECTED'],
  REJECTED: [],
  REIMBURSED: [],
  CANCELLED: [],
};

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

// Generate a human-friendly, per-tenant sequential claim reference (EXP-0001).
// claimNumber is nullable and not DB-unique, so we derive the next ordinal from
// the highest existing EXP-#### for this tenant and retry on the rare race.
async function nextClaimNumber(businessId) {
  const last = await prisma.expenseClaim.findFirst({
    where: { businessId, claimNumber: { startsWith: 'EXP-' } },
    orderBy: { claimNumber: 'desc' },
    select: { claimNumber: true },
  });
  const n = last ? (parseInt(String(last.claimNumber).slice(4), 10) || 0) : 0;
  return `EXP-${String(n + 1).padStart(4, '0')}`;
}

// ── Category handlers ────────────────────────────────────────────────────────

async function listCategories(req, res, next) {
  try {
    const { businessId } = req.user;
    const items = await prisma.expenseCategory.findMany({
      where: { businessId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

async function createCategory(req, res, next) {
  try {
    const { businessId } = req.user;
    const { code, name } = req.body;
    if (!code || !name) return res.status(400).json({ message: 'code and name are required' });
    const item = await prisma.expenseCategory.create({ data: { ...pickCategory(req.body), businessId } });
    res.status(201).json(item);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A category with that code already exists' });
    next(e);
  }
}

async function updateCategory(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.expenseCategory.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Category not found' });
    const item = await prisma.expenseCategory.update({ where: { id: req.params.id }, data: pickCategory(req.body) });
    res.json(item);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A category with that code already exists' });
    next(e);
  }
}

async function removeCategory(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.expenseCategory.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Category not found' });
    await prisma.expenseCategory.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// ── Claim handlers ───────────────────────────────────────────────────────────

async function list(req, res, next) {
  try {
    const { businessId } = req.user;
    const { status, employeeId, categoryId, page = '1', pageSize = '25' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const where = { businessId, deletedAt: null };
    if (status) where.status = status;
    if (employeeId) where.employeeId = employeeId;
    if (categoryId) where.categoryId = categoryId;

    const [items, total] = await Promise.all([
      prisma.expenseClaim.findMany({
        where,
        // Embed the person + category so the admin list renders real names
        // instead of raw UUIDs (the table falls back to employeeId otherwise).
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, code: true } },
          category: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.expenseClaim.count({ where }),
    ]);
    res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take });
  } catch (e) { next(e); }
}

async function get(req, res, next) {
  try {
    const { businessId } = req.user;
    const claim = await prisma.expenseClaim.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: { lines: true, category: true },
    });
    if (!claim) return res.status(404).json({ message: 'Expense claim not found' });
    res.json(claim);
  } catch (e) { next(e); }
}

async function create(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, amount } = req.body;
    if (!employeeId) return res.status(400).json({ message: 'employeeId is required' });
    if (amount === undefined || amount === null || amount === '') {
      return res.status(400).json({ message: 'amount is required' });
    }
    if (Number(amount) <= 0 || Number.isNaN(Number(amount))) {
      return res.status(400).json({ message: 'amount must be a positive number' });
    }

    // Ownership / tenancy: the employee must belong to this tenant.
    const employee = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null } });
    if (!employee) return res.status(400).json({ message: 'employeeId does not reference a valid employee' });

    // Category, when supplied, must also belong to this tenant.
    if (req.body.categoryId) {
      const category = await prisma.expenseCategory.findFirst({
        where: { id: req.body.categoryId, businessId, deletedAt: null },
      });
      if (!category) return res.status(400).json({ message: 'categoryId does not reference a valid category' });
    }

    const data = { ...pickClaim(req.body), businessId, status: 'DRAFT' };
    // Auto-assign a sequential reference (EXP-####) unless one was supplied.
    // Retry a couple of times in case two claims race onto the same ordinal.
    let claim;
    for (let attempt = 0; ; attempt += 1) {
      if (!data.claimNumber) data.claimNumber = await nextClaimNumber(businessId);
      try {
        claim = await prisma.expenseClaim.create({ data });
        break;
      } catch (err) {
        if (err.code === 'P2002' && !req.body.claimNumber && attempt < 3) {
          data.claimNumber = null; // recompute the next ordinal and retry
          continue;
        }
        throw err;
      }
    }
    res.status(201).json(claim);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A claim with that number already exists' });
    next(e);
  }
}

// Only DRAFT claims may be edited (post-submission they are immutable except via
// the workflow actions). The amount/category are still allow-listed.
async function update(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.expenseClaim.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Expense claim not found' });
    if (existing.status !== 'DRAFT') {
      return res.status(409).json({ message: `Cannot edit a claim in status ${existing.status}` });
    }
    if (req.body.amount !== undefined) {
      if (Number(req.body.amount) <= 0 || Number.isNaN(Number(req.body.amount))) {
        return res.status(400).json({ message: 'amount must be a positive number' });
      }
    }
    if (req.body.categoryId) {
      const category = await prisma.expenseCategory.findFirst({
        where: { id: req.body.categoryId, businessId, deletedAt: null },
      });
      if (!category) return res.status(400).json({ message: 'categoryId does not reference a valid category' });
    }
    const claim = await prisma.expenseClaim.update({ where: { id: req.params.id }, data: pickClaim(req.body) });
    res.json(claim);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A claim with that number already exists' });
    next(e);
  }
}

// Generic guarded state-transition helper. Loads the tenant-scoped claim,
// validates the requested transition against the state machine, then applies
// the new status plus any workflow stamps.
async function transition(req, res, next, target, stampFn) {
  try {
    const { businessId } = req.user;
    const claim = await prisma.expenseClaim.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!claim) return res.status(404).json({ message: 'Expense claim not found' });
    if (claim.status === target) {
      return res.status(409).json({ message: `Claim is already ${target}` });
    }
    if (!canTransition(claim.status, target)) {
      return res.status(409).json({ message: `Cannot move claim from ${claim.status} to ${target}` });
    }
    const data = { status: target, ...(stampFn ? stampFn(req) : {}) };
    const updated = await prisma.expenseClaim.update({ where: { id: req.params.id }, data });
    res.json(updated);
  } catch (e) { next(e); }
}

// Find the OPEN approval-engine request gating this ExpenseClaim (claims submitted
// after slice 10c). Null for a pre-10c claim → the controller uses the direct flip.
async function findOpenApprovalRequest(businessId, claimId) {
  return prisma.approvalRequest.findFirst({
    where: { businessId, module: 'EXPENSE', entityType: 'ExpenseClaim', entityId: claimId, status: { in: ['PENDING', 'ESCALATED'] } },
  });
}

// Feature 26 — resolve the tenant/entity DEFAULT reimbursement payout channel for an
// employee (from their CURRENT employment's Entity). Returns null when no current
// employment / entity is found, so the caller leaves the schema default in place.
async function resolveDefaultPayoutChannel(businessId, employeeId) {
  const emp = await prisma.employmentRecord.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    select: { entity: { select: { reimbursementDefaultChannel: true } } },
  });
  return emp && emp.entity ? emp.entity.reimbursementDefaultChannel : null;
}

// Requester submits a DRAFT claim for approval. Flips DRAFT→SUBMITTED AND opens the
// approval-engine request in the SAME tx — replacing the bare `canManageEmployees`
// flip with a real, configurable chain. ctx carries the routing dimensions
// (amount → the threshold condition; categoryCode/departmentId for scoped defs).
async function submit(req, res, next) {
  try {
    const { businessId } = req.user;
    const claim = await prisma.expenseClaim.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: { category: { select: { code: true } } },
    });
    if (!claim) return res.status(404).json({ message: 'Expense claim not found' });
    if (claim.status === 'SUBMITTED') return res.status(409).json({ message: 'Claim is already SUBMITTED' });
    if (!canTransition(claim.status, 'SUBMITTED')) {
      return res.status(409).json({ message: `Cannot move claim from ${claim.status} to SUBMITTED` });
    }

    // Feature 26 — seed the payout channel from the tenant/entity default at submit, but
    // ONLY when the claim still carries the schema default (PAY_SEPARATELY) and the
    // requester didn't already set one. A per-claim choice always wins; the channel stays
    // editable while APPROVED + un-stamped via PATCH /payout-channel below.
    let defaultChannel = null;
    if (claim.payoutChannel === 'PAY_SEPARATELY') {
      defaultChannel = await resolveDefaultPayoutChannel(businessId, claim.employeeId);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const flip = await tx.expenseClaim.updateMany({
        where: { id: claim.id, status: claim.status },
        data: {
          status: 'SUBMITTED',
          submittedAt: new Date(),
          ...(defaultChannel && defaultChannel !== 'PAY_SEPARATELY' ? { payoutChannel: defaultChannel } : {}),
        },
      });
      if (flip.count === 0) {
        const err = new Error('Claim changed concurrently'); err.code = 'DECISION_RACE'; throw err;
      }
      // Returned-claim resubmit: supersede any stale OPEN request left PENDING by a
      // prior REQUESTED_CHANGES return (which sent the claim back to DRAFT) WITHOUT
      // firing onCancel — the claim is authoritatively SUBMITTED here, so it must not
      // flip to CANCELLED. Prevents two open EXPENSE requests gating one claim.
      await tx.approvalRequest.updateMany({
        where: { businessId, module: 'EXPENSE', entityType: 'ExpenseClaim', entityId: claim.id, status: { in: ['PENDING', 'ESCALATED'] } },
        data: { status: 'WITHDRAWN', completedAt: new Date(), slaDueAt: null },
      });
      await engine.openRequest({
        businessId,
        module: 'EXPENSE',
        entityType: 'ExpenseClaim',
        entityId: claim.id,
        requesterEmployeeId: claim.employeeId,
        payload: {
          amount: claim.amount != null ? String(claim.amount) : null,
          category: claim.category ? claim.category.code : null,
          claimNumber: claim.claimNumber || null,
        },
        ctx: {
          entityId: claim.id,
          amount: Number(claim.amount),
          categoryCode: claim.category ? claim.category.code : null,
          departmentId: null,
        },
      }, tx);
      return tx.expenseClaim.findUnique({ where: { id: claim.id } });
    });
    res.json(updated);
  } catch (e) {
    if (e && (e.code === 'DECISION_RACE' || e.code === 'P2025' || e.code === 'CONCURRENT_UPDATE')) {
      return res.status(409).json({ message: 'Claim changed concurrently; please retry', reason: 'CONCURRENT_UPDATE' });
    }
    next(e);
  }
}

// Shared approve/reject/cancel seam. The route RBAC (canManageEmployees) is the
// authoritative gate; an open engine request → drive the engine as a trusted
// systemActor (it fires the EXPENSE consumer that flips the claim); a pre-10c claim
// with no engine request → the legacy direct flip. Either way the claim lands in the
// target status with decidedBy/decidedAt stamped.
async function driveClaimDecision(req, res, next, { decision, target, stampFn }) {
  try {
    const { businessId } = req.user;
    const claim = await prisma.expenseClaim.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!claim) return res.status(404).json({ message: 'Expense claim not found' });
    if (claim.status === target) return res.status(409).json({ message: `Claim is already ${target}` });
    if (!canTransition(claim.status, target)) {
      return res.status(409).json({ message: `Cannot move claim from ${claim.status} to ${target}` });
    }

    const open = await findOpenApprovalRequest(businessId, claim.id);
    if (open) {
      const decidedBy = req.user.id || null;
      const reason = (req.body && (req.body.reason || req.body.rejectReason)) || null;
      if (decision === 'CANCELLED') {
        await engine.cancel({ approvalRequestId: open.id, actorUserId: decidedBy || 'REQUESTER', comment: reason });
      } else {
        await prisma.approvalRequest.update({
          where: { id: open.id },
          data: { decidedBy, ...(reason ? { payloadJson: { ...(open.payloadJson || {}), rejectReason: reason } } : {}) },
        });
        await engine.recordDecision({ approvalRequestId: open.id, actorUserId: decidedBy || 'SYSTEM', decision, comment: reason, systemActor: true });
      }
      const updated = await prisma.expenseClaim.findUnique({ where: { id: claim.id } });
      return res.json(updated);
    }

    // Direct path (no engine request) — the legacy guarded flip.
    const data = { status: target, ...(stampFn ? stampFn(req) : {}) };
    const updated = await prisma.expenseClaim.update({ where: { id: claim.id }, data });
    res.json(updated);
  } catch (e) {
    if (e && (e.code === 'DECISION_RACE' || e.code === 'P2025' || e.code === 'CONCURRENT_UPDATE')) {
      return res.status(409).json({ message: 'Claim changed concurrently; please retry', reason: 'CONCURRENT_UPDATE' });
    }
    next(e);
  }
}

// Approver action (canManageEmployees) — manager/HR per the resolved chain.
function approve(req, res, next) {
  return driveClaimDecision(req, res, next, {
    decision: 'APPROVED', target: 'APPROVED',
    stampFn: (r) => ({ decidedAt: new Date(), decidedBy: r.user.id, rejectReason: null }),
  });
}

function reject(req, res, next) {
  return driveClaimDecision(req, res, next, {
    decision: 'REJECTED', target: 'REJECTED',
    stampFn: (r) => ({ decidedAt: new Date(), decidedBy: r.user.id, rejectReason: r.body.reason || r.body.rejectReason || null }),
  });
}

// Finance marks an APPROVED claim as paid out (post-approval; not an engine step).
function reimburse(req, res, next) {
  return transition(req, res, next, 'REIMBURSED', (r) => ({
    reimbursedAt: new Date(),
    reimbursedBy: r.user.id,
    paymentRef: r.body.paymentRef || null,
    payRunId: r.body.payRunId || null,
  }));
}

// Requester withdraws their own DRAFT/SUBMITTED claim. A SUBMITTED claim with an open
// engine request cancels the chain (fires onCancel); a DRAFT claim (no request) flips
// directly.
function cancel(req, res, next) {
  return driveClaimDecision(req, res, next, { decision: 'CANCELLED', target: 'CANCELLED', stampFn: () => ({}) });
}

// Feature 26 — set/flip the per-claim payout channel (PAY_VIA_PAYROLL ↔ PAY_SEPARATELY).
// Editable only while the claim is un-paid AND in an editable state (DRAFT/SUBMITTED/
// APPROVED): 409 once a run has stamped it (payRunId set) so the channel can't change
// out from under a computed run, and 409 in a terminal state (REIMBURSED/REJECTED/
// CANCELLED). A claim already settled out-of-band keeps PAY_SEPARATELY frozen.
async function setPayoutChannel(req, res, next) {
  try {
    const { businessId } = req.user;
    const channel = req.body && req.body.payoutChannel;
    if (channel !== 'PAY_VIA_PAYROLL' && channel !== 'PAY_SEPARATELY') {
      return res.status(400).json({ message: 'payoutChannel must be PAY_VIA_PAYROLL or PAY_SEPARATELY' });
    }
    const claim = await prisma.expenseClaim.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!claim) return res.status(404).json({ message: 'Expense claim not found' });
    // Once a pay run has picked the claim up (or it was settled), the channel is frozen.
    if (claim.payRunId) {
      return res.status(409).json({ message: 'Channel is frozen: this claim is already scheduled/paid through a pay run' });
    }
    if (!['DRAFT', 'SUBMITTED', 'APPROVED'].includes(claim.status)) {
      return res.status(409).json({ message: `Cannot change payout channel of a ${claim.status} claim` });
    }
    const flip = await prisma.expenseClaim.updateMany({
      where: { id: claim.id, version: claim.version, payRunId: null },
      data: { payoutChannel: channel, version: { increment: 1 } },
    });
    if (flip.count === 0) return res.status(409).json({ message: 'Claim changed concurrently; please retry' });
    res.json(await prisma.expenseClaim.findUnique({ where: { id: claim.id } }));
  } catch (e) { next(e); }
}

module.exports = {
  // categories
  listCategories, createCategory, updateCategory, removeCategory,
  // claims
  list, get, create, update,
  submit, approve, reject, reimburse, cancel,
  // Feature 26
  setPayoutChannel, resolveDefaultPayoutChannel,
};
