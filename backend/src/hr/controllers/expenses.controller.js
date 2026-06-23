'use strict';
// Expense reimbursement. Employees raise an ExpenseClaim against an
// ExpenseCategory; it walks a DRAFT → SUBMITTED → APPROVED/REJECTED → REIMBURSED
// state machine (CANCELLED is the requester's withdraw path). Every query is
// tenant-scoped by req.user.businessId; reads filter deletedAt: null; money
// (amount) is a Prisma Decimal and is passed through untouched (never parsed).
// Approve/reject/reimburse are gated by canManageEmployees at the route layer.
const prisma = require('../../core/lib/prisma');

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

// Requester submits a DRAFT claim for approval.
function submit(req, res, next) {
  return transition(req, res, next, 'SUBMITTED', () => ({ submittedAt: new Date() }));
}

// Approver action (canManageEmployees).
function approve(req, res, next) {
  return transition(req, res, next, 'APPROVED', (r) => ({ decidedAt: new Date(), decidedBy: r.user.id, rejectReason: null }));
}

function reject(req, res, next) {
  return transition(req, res, next, 'REJECTED', (r) => ({
    decidedAt: new Date(),
    decidedBy: r.user.id,
    rejectReason: r.body.reason || r.body.rejectReason || null,
  }));
}

// Finance marks an APPROVED claim as paid out.
function reimburse(req, res, next) {
  return transition(req, res, next, 'REIMBURSED', (r) => ({
    reimbursedAt: new Date(),
    reimbursedBy: r.user.id,
    paymentRef: r.body.paymentRef || null,
    payRunId: r.body.payRunId || null,
  }));
}

// Requester withdraws their own DRAFT/SUBMITTED claim.
function cancel(req, res, next) {
  return transition(req, res, next, 'CANCELLED', () => ({}));
}

module.exports = {
  // categories
  listCategories, createCategory, updateCategory, removeCategory,
  // claims
  list, get, create, update,
  submit, approve, reject, reimburse, cancel,
};
