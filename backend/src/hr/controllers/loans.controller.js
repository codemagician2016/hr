'use strict';
// Employee loans / salary advances. Tenant-scoped by req.user.businessId and the
// owning employeeId; soft-delete via deletedAt. A Loan moves through a lifecycle
//   DRAFT → PENDING → APPROVED → DISBURSED → CLOSED   (REJECTED / CANCELLED exit)
// and carries a generated LoanInstallment (EMI) schedule. Money is Prisma Decimal
// (15,2) — amounts are passed through as numbers/strings, never parseInt'd; only
// internal schedule arithmetic uses a fixed-scale helper to avoid float drift.
const prisma = require('../../core/lib/prisma');
// Program Phase 2 — LOAN rides the approval engine: submit opens an
// ApprovalRequest (BUILT_IN_DEFAULT: one HR step) and the legacy direct
// approve/reject/cancel routes drive engine.recordDecision/cancel (systemActor —
// their canManageCompensation gate stays the authz), with the domain flip in
// approvals/consumers.loan.js. Direct decisions on rows with NO open request
// (pre-engine legacy, or approving a DRAFT without submit) keep the old path.
const engine = require('../approvals/engine');
require('../approvals/consumers.loan');

async function openLoanApproval(tx, loan) {
  // Scope ctx from the current employment record (dept/grade drive scoped defs).
  const rec = await tx.employmentRecord.findFirst({
    where: { businessId: loan.businessId, employeeId: loan.employeeId, isCurrent: true },
    orderBy: { effectiveFrom: 'desc' },
    select: { departmentId: true, gradeId: true, locationId: true },
  });
  return engine.openRequest({
    businessId: loan.businessId,
    module: 'LOAN',
    entityType: 'Loan',
    entityId: loan.id,
    requesterEmployeeId: loan.employeeId,
    payload: {
      number: loan.loanNumber || null,
      loanType: loan.loanType,
      principal: String(loan.principal),
      tenureMonths: loan.tenureMonths,
      amount: Number(loan.principal),
    },
    ctx: {
      entityId: loan.id,
      amount: Number(loan.principal),
      departmentId: rec ? rec.departmentId : null,
      employeeLevel: rec ? rec.gradeId : null,
      locationId: rec ? rec.locationId : null,
    },
  }, tx);
}

async function findOpenLoanRequest(businessId, loanId, tx = prisma) {
  return tx.approvalRequest.findFirst({
    where: { businessId, module: 'LOAN', entityId: loanId, status: { in: ['PENDING', 'ESCALATED'] } },
    orderBy: { createdAt: 'desc' },
  });
}

const LIST_SELECT = {
  id: true, loanNumber: true, employeeId: true, schemeId: true, loanType: true,
  principal: true, interestRate: true, interestMethod: true,
  currencyCode: true, tenureMonths: true, emiAmount: true,
  startDate: true, status: true, amountRepaid: true, outstanding: true,
  createdAt: true,
  // Embed the person so the admin list shows a real name, not a raw UUID.
  employee: { select: { id: true, firstName: true, lastName: true, code: true } },
};

// LoanType enum (mirrors prisma/schema.prisma). We validate against this before
// hitting Prisma so a bad value returns a clean 422 instead of leaking a raw
// Prisma validation string through the 500 handler.
const LOAN_TYPES = ['LOAN', 'ADVANCE'];

// Allow-list of directly-assignable Loan fields (never trust the body wholesale).
const WRITABLE = [
  'employeeId', 'schemeId', 'loanNumber', 'loanType', 'principal', 'interestRate',
  'interestMethod', 'currencyCode', 'tenureMonths', 'emiAmount', 'startDate', 'reason',
];
const DATE_FIELDS = ['startDate'];
const INT_FIELDS = ['tenureMonths'];

function pickWritable(body) {
  const out = {};
  for (const f of WRITABLE) if (body[f] !== undefined) out[f] = body[f];
  for (const d of DATE_FIELDS) if (out[d] != null) out[d] = new Date(out[d]);
  // tenureMonths is a true count → Int. Money fields stay as-is (Decimal).
  for (const i of INT_FIELDS) if (out[i] != null) out[i] = parseInt(out[i], 10);
  return out;
}

// Fixed-scale (2dp) integer-cents arithmetic so schedule rows sum exactly to the
// total payable. Returns a string suitable for a Prisma Decimal column.
function toCents(v) { return Math.round(Number(v) * 100); }
function fromCents(c) { return (c / 100).toFixed(2); }

// Accepted interest methods (mirrors prisma enum LoanInterestMethod).
const LOAN_INTEREST_METHODS = ['FLAT', 'REDUCING_BALANCE', 'SIMPLE', 'ZERO'];

// ── REDUCING_BALANCE: standard amortised EMI ─────────────────────────────────
// Monthly rate r = annualRate/12/100; level EMI = P·r·(1+r)^n / ((1+r)^n − 1).
// Interest each period = round(outstanding × r), principal = EMI − interest,
// outstanding -= principal. The FINAL row pays off the entire remaining balance
// so Σprincipal == P exactly and the outstanding ends at 0 (the last amount
// absorbs all accumulated rounding). All arithmetic is in integer paise, matching
// the flat path's minor-unit convention. Returns { rows (no dueDate), totalPayableC }.
function reducingSchedule(principalC, annualRatePct, n) {
  const r = annualRatePct / 12 / 100; // monthly fraction
  const pow = Math.pow(1 + r, n);
  const emiC = Math.round((principalC * r * pow) / (pow - 1));
  const rows = [];
  let outstanding = principalC;
  let totalInterestC = 0;
  for (let seq = 1; seq <= n; seq++) {
    const interestC = Math.round(outstanding * r);
    let principalC2;
    if (seq === n) {
      // Final row clears the balance — absorbs any cumulative rounding drift.
      principalC2 = outstanding;
    } else {
      principalC2 = emiC - interestC;
      if (principalC2 > outstanding) principalC2 = outstanding; // defensive clamp
      if (principalC2 < 0) principalC2 = 0;
    }
    outstanding -= principalC2;
    totalInterestC += interestC;
    rows.push({
      seq,
      principalComponent: fromCents(principalC2),
      interestComponent: fromCents(interestC),
      amount: fromCents(principalC2 + interestC),
    });
  }
  return { rows, totalPayableC: principalC + totalInterestC };
}

// ── Pure schedule builder ────────────────────────────────────────────────────
// computeSchedule({ principalMinor, annualRatePct, tenureMonths, method }) → the
// per-installment split, branched by interest method. NO dates, NO DB — the
// controller/consumer stamp dueDates from startDate. Rows carry the same
// principalComponent / interestComponent / amount (2dp strings) the DB stores.
//
//   FLAT / SIMPLE      — simple interest (P·rate%·tenure/12) split evenly, remainder
//                        into the final row. IDENTICAL to the historical math
//                        (regression-critical — do not alter).
//   ZERO               — no interest regardless of rate (equal-principal).
//   REDUCING_BALANCE   — amortised on the outstanding balance (see above).
function computeSchedule({ principalMinor, annualRatePct, tenureMonths, method }) {
  const n = tenureMonths;
  const principalC = Math.round(Number(principalMinor));
  const m = String(method || 'FLAT').toUpperCase();
  const rate = annualRatePct != null ? Number(annualRatePct) : 0;

  // REDUCING_BALANCE with a positive rate amortises; a zero/negative rate
  // degenerates to equal-principal, which the flat path below handles.
  if (m === 'REDUCING_BALANCE' && rate > 0) {
    return reducingSchedule(principalC, rate, n);
  }

  // FLAT / SIMPLE / ZERO (and REDUCING with no rate). ZERO forces interest to 0;
  // FLAT/SIMPLE keep EXACTLY the historical simple-interest formula.
  const totalInterestC = (m === 'ZERO' || rate <= 0)
    ? 0
    : Math.round((principalC * rate / 100) * (n / 12));

  const basePrinC = Math.floor(principalC / n);
  const baseIntC = Math.floor(totalInterestC / n);
  const prinRem = principalC - basePrinC * n;
  const intRem = totalInterestC - baseIntC * n;

  const rows = [];
  for (let seq = 1; seq <= n; seq++) {
    let p = basePrinC;
    let i = baseIntC;
    if (seq === n) { p += prinRem; i += intRem; } // remainder into final row
    rows.push({
      seq,
      principalComponent: fromCents(p),
      interestComponent: fromCents(i),
      amount: fromCents(p + i),
    });
  }
  return { rows, totalPayableC: principalC + totalInterestC };
}

// Build a repayment schedule for a loan, branching by loan.interestMethod. Thin
// wrapper over the pure computeSchedule: it stamps each row's dueDate from
// startDate (monthly). The return shape is unchanged from the original
// buildSchedule ({ rows: [{ seq, dueDate, principalComponent, interestComponent,
// amount }], totalPayableC }) so approvals/consumers.loan.js is untouched.
function buildSchedule(loan) {
  const { rows, totalPayableC } = computeSchedule({
    principalMinor: toCents(loan.principal),
    annualRatePct: loan.interestRate != null ? Number(loan.interestRate) : null,
    tenureMonths: loan.tenureMonths,
    method: loan.interestMethod || 'FLAT',
  });
  const start = new Date(loan.startDate);
  const dated = rows.map((row) => {
    const due = new Date(start);
    due.setMonth(due.getMonth() + (row.seq - 1));
    return {
      seq: row.seq,
      dueDate: due,
      principalComponent: row.principalComponent,
      interestComponent: row.interestComponent,
      amount: row.amount,
    };
  });
  return { rows: dated, totalPayableC };
}

// Generate a human-friendly, per-tenant sequential loan reference (LOAN-0001).
// loanNumber is nullable and not DB-unique, so we derive the next ordinal from
// the highest existing LOAN-#### for this tenant and retry on the rare race.
async function nextLoanNumber(businessId) {
  const last = await prisma.loan.findFirst({
    where: { businessId, loanNumber: { startsWith: 'LOAN-' } },
    orderBy: { loanNumber: 'desc' },
    select: { loanNumber: true },
  });
  const n = last ? (parseInt(String(last.loanNumber).slice(5), 10) || 0) : 0;
  return `LOAN-${String(n + 1).padStart(4, '0')}`;
}

// Confirm an employee belongs to this tenant before linking a loan to it.
async function employeeInTenant(businessId, employeeId) {
  if (!employeeId) return false;
  const emp = await prisma.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true },
  });
  return !!emp;
}

async function list(req, res, next) {
  try {
    const { businessId } = req.user;
    const { status, employeeId, loanType, page = '1', pageSize = '25' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const where = { businessId, deletedAt: null };
    if (status) where.status = status;
    if (employeeId) where.employeeId = employeeId;
    if (loanType) where.loanType = loanType;

    const [items, total] = await Promise.all([
      prisma.loan.findMany({ where, select: LIST_SELECT, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.loan.count({ where }),
    ]);
    res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take });
  } catch (e) { next(e); }
}

// All loans for one employee (tenant-scoped). Lightweight, but still paginated.
async function listByEmployee(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;
    const { status, page = '1', pageSize = '25' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const where = { businessId, employeeId, deletedAt: null };
    if (status) where.status = status;

    const [items, total] = await Promise.all([
      prisma.loan.findMany({ where, select: LIST_SELECT, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.loan.count({ where }),
    ]);
    res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take });
  } catch (e) { next(e); }
}

async function get(req, res, next) {
  try {
    const { businessId } = req.user;
    const loan = await prisma.loan.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: {
        installments: { orderBy: { seq: 'asc' } },
        scheme: { select: { id: true, code: true, name: true } },
      },
    });
    if (!loan) return res.status(404).json({ message: 'Loan not found' });
    res.json(loan);
  } catch (e) { next(e); }
}

// The installment schedule for a loan (404 if the loan isn't in this tenant).
async function listInstallments(req, res, next) {
  try {
    const { businessId } = req.user;
    const loan = await prisma.loan.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      select: { id: true },
    });
    if (!loan) return res.status(404).json({ message: 'Loan not found' });
    const items = await prisma.loanInstallment.findMany({
      where: { businessId, loanId: req.params.id },
      orderBy: { seq: 'asc' },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

async function create(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, principal, tenureMonths, startDate } = req.body;
    if (!employeeId || principal == null || tenureMonths == null || !startDate) {
      return res.status(400).json({ message: 'employeeId, principal, tenureMonths and startDate are required' });
    }
    if (Number(principal) <= 0) return res.status(400).json({ message: 'principal must be greater than 0' });
    const tenure = parseInt(tenureMonths, 10);
    if (!Number.isInteger(tenure) || tenure < 1) {
      return res.status(400).json({ message: 'tenureMonths must be a positive integer' });
    }
    // Validate the enum before Prisma sees it — a bad loanType would otherwise
    // surface as a raw Prisma validation string via the 500 handler.
    if (req.body.loanType !== undefined && !LOAN_TYPES.includes(req.body.loanType)) {
      return res.status(422).json({ message: 'Invalid loanType', allowed: LOAN_TYPES });
    }
    if (req.body.interestMethod !== undefined && !LOAN_INTEREST_METHODS.includes(req.body.interestMethod)) {
      return res.status(422).json({ message: 'Invalid interestMethod', allowed: LOAN_INTEREST_METHODS });
    }
    if (!(await employeeInTenant(businessId, employeeId))) {
      return res.status(400).json({ message: 'employeeId does not reference an employee in this business' });
    }
    // If a scheme is supplied, validate tenant ownership and snapshot its rate +
    // interest method (a body value always wins; the scheme fills the gap).
    let interestRate = req.body.interestRate;
    let interestMethod = req.body.interestMethod;
    if (req.body.schemeId) {
      const scheme = await prisma.loanScheme.findFirst({
        where: { id: req.body.schemeId, businessId, deletedAt: null },
        select: { id: true, interestRate: true, interestMethod: true, loanType: true },
      });
      if (!scheme) return res.status(400).json({ message: 'schemeId does not reference a scheme in this business' });
      if (interestRate == null) interestRate = scheme.interestRate;
      if (interestMethod == null) interestMethod = scheme.interestMethod;
    }

    const data = { ...pickWritable(req.body), businessId, status: 'DRAFT' };
    if (interestRate != null) data.interestRate = interestRate;
    if (interestMethod != null) data.interestMethod = interestMethod;

    // Auto-assign a sequential reference (LOAN-####) unless one was supplied.
    // Retry a couple of times in case two loans race onto the same ordinal.
    let loan;
    for (let attempt = 0; ; attempt += 1) {
      if (!data.loanNumber) data.loanNumber = await nextLoanNumber(businessId);
      try {
        loan = await prisma.loan.create({ data });
        break;
      } catch (err) {
        if (err.code === 'P2002' && !req.body.loanNumber && attempt < 3) {
          data.loanNumber = null; // recompute the next ordinal and retry
          continue;
        }
        throw err;
      }
    }
    res.status(201).json(loan);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A loan with that number already exists' });
    next(e);
  }
}

// Editing is only allowed while the loan is still mutable (DRAFT / PENDING).
async function update(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.loan.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Loan not found' });
    if (!['DRAFT', 'PENDING'].includes(existing.status)) {
      return res.status(409).json({ message: `Cannot edit a loan in ${existing.status} state` });
    }
    // Re-validate employee/scheme ownership if either is being reassigned.
    const data = pickWritable(req.body);
    if (req.body.loanType !== undefined && !LOAN_TYPES.includes(req.body.loanType)) {
      return res.status(422).json({ message: 'Invalid loanType', allowed: LOAN_TYPES });
    }
    if (req.body.interestMethod !== undefined && !LOAN_INTEREST_METHODS.includes(req.body.interestMethod)) {
      return res.status(422).json({ message: 'Invalid interestMethod', allowed: LOAN_INTEREST_METHODS });
    }
    if (data.employeeId && !(await employeeInTenant(businessId, data.employeeId))) {
      return res.status(400).json({ message: 'employeeId does not reference an employee in this business' });
    }
    if (data.schemeId) {
      const scheme = await prisma.loanScheme.findFirst({
        where: { id: data.schemeId, businessId, deletedAt: null }, select: { id: true },
      });
      if (!scheme) return res.status(400).json({ message: 'schemeId does not reference a scheme in this business' });
    }
    if (data.principal != null && Number(data.principal) <= 0) {
      return res.status(400).json({ message: 'principal must be greater than 0' });
    }
    if (data.tenureMonths != null && data.tenureMonths < 1) {
      return res.status(400).json({ message: 'tenureMonths must be a positive integer' });
    }
    const loan = await prisma.loan.update({ where: { id: req.params.id }, data });
    res.json(loan);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A loan with that number already exists' });
    next(e);
  }
}

// Submit for approval: DRAFT → PENDING.
async function submit(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.loan.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Loan not found' });
    if (existing.status !== 'DRAFT') {
      return res.status(409).json({ message: `Only a DRAFT loan can be submitted (currently ${existing.status})` });
    }
    const loan = await prisma.$transaction(async (tx) => {
      const updated = await tx.loan.update({
        where: { id: req.params.id },
        data: { status: 'PENDING', submittedAt: new Date() },
      });
      // Open the approval request in the SAME tx. If the tenant's chain
      // auto-approves, the consumer flips the loan APPROVED before commit.
      await openLoanApproval(tx, updated);
      return tx.loan.findUnique({ where: { id: updated.id } });
    });
    res.json(loan);
  } catch (e) { next(e); }
}

// Approve: DRAFT/PENDING → APPROVED. Generates the installment schedule atomically
// and stamps the denormalised totals so disbursement/recovery have a source.
async function approve(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.loan.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Loan not found' });
    if (!['DRAFT', 'PENDING'].includes(existing.status)) {
      return res.status(409).json({ message: `Cannot approve a loan in ${existing.status} state` });
    }

    // Engine path: an open request means THIS decision routes through the engine
    // (consumer builds the schedule + flips). systemActor — this route's
    // permission gate stays the authz; the inbox path enforces membership.
    const open = await findOpenLoanRequest(businessId, existing.id);
    if (open) {
      await engine.recordDecision({
        approvalRequestId: open.id,
        actorUserId: req.user.id || req.user.userId || 'SYSTEM',
        decision: 'APPROVED',
        systemActor: true,
      });
      return res.json(await prisma.loan.findUnique({ where: { id: existing.id } }));
    }

    const { rows, totalPayableC } = buildSchedule(existing);
    const totalPayable = fromCents(totalPayableC);

    const loan = await prisma.$transaction(async (tx) => {
      // Regenerate cleanly in case of a prior partial attempt.
      await tx.loanInstallment.deleteMany({ where: { businessId, loanId: existing.id } });
      await tx.loanInstallment.createMany({
        data: rows.map((r) => ({ ...r, businessId, loanId: existing.id })),
      });
      return tx.loan.update({
        where: { id: existing.id },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          approvedBy: req.user.id || req.user.userId || null,
          totalPayable,
          outstanding: totalPayable,
          amountRepaid: '0',
        },
      });
    });

    res.json(loan);
  } catch (e) { next(e); }
}

// Reject: DRAFT/PENDING → REJECTED.
async function reject(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.loan.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Loan not found' });
    if (!['DRAFT', 'PENDING'].includes(existing.status)) {
      return res.status(409).json({ message: `Cannot reject a loan in ${existing.status} state` });
    }
    const open = await findOpenLoanRequest(businessId, existing.id);
    if (open) {
      await engine.recordDecision({
        approvalRequestId: open.id,
        actorUserId: req.user.id || req.user.userId || 'SYSTEM',
        decision: 'REJECTED',
        comment: req.body.reason || null,
        systemActor: true,
      });
      return res.json(await prisma.loan.findUnique({ where: { id: existing.id } }));
    }
    const loan = await prisma.loan.update({
      where: { id: req.params.id },
      data: { status: 'REJECTED', rejectedAt: new Date(), rejectReason: req.body.reason || null },
    });
    res.json(loan);
  } catch (e) { next(e); }
}

// Disburse: APPROVED → DISBURSED. Records the payout reference; schedule must exist.
async function disburse(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.loan.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Loan not found' });
    if (existing.status !== 'APPROVED') {
      return res.status(409).json({ message: `Only an APPROVED loan can be disbursed (currently ${existing.status})` });
    }
    const loan = await prisma.loan.update({
      where: { id: req.params.id },
      data: {
        status: 'DISBURSED',
        disbursedAt: req.body.disbursedAt ? new Date(req.body.disbursedAt) : new Date(),
        disbursedBy: req.user.id || req.user.userId || null,
        disbursementRef: req.body.disbursementRef || null,
      },
    });
    res.json(loan);
  } catch (e) { next(e); }
}

// Close: DISBURSED → CLOSED (fully recovered / written off).
async function close(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.loan.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Loan not found' });
    if (existing.status !== 'DISBURSED') {
      return res.status(409).json({ message: `Only a DISBURSED loan can be closed (currently ${existing.status})` });
    }
    const loan = await prisma.loan.update({
      where: { id: req.params.id },
      data: { status: 'CLOSED', closedAt: new Date(), outstanding: '0' },
    });
    res.json(loan);
  } catch (e) { next(e); }
}

// Cancel: DRAFT/PENDING/APPROVED → CANCELLED (pre-disbursement only). Drops any
// generated schedule so a cancelled loan carries no live installments.
async function cancel(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.loan.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Loan not found' });
    if (!['DRAFT', 'PENDING', 'APPROVED'].includes(existing.status)) {
      return res.status(409).json({ message: `Cannot cancel a loan in ${existing.status} state` });
    }
    // Close any open approval request alongside (fires the consumer onCancel,
    // which performs the same installment-drop + CANCELLED flip).
    const open = await findOpenLoanRequest(businessId, existing.id);
    if (open) {
      await engine.cancel({
        approvalRequestId: open.id,
        actorUserId: req.user.id || req.user.userId || 'SYSTEM',
        comment: req.body && req.body.reason ? req.body.reason : null,
      });
      return res.json(await prisma.loan.findUnique({ where: { id: existing.id } }));
    }
    const loan = await prisma.$transaction(async (tx) => {
      await tx.loanInstallment.deleteMany({ where: { businessId, loanId: existing.id } });
      return tx.loan.update({ where: { id: existing.id }, data: { status: 'CANCELLED' } });
    });
    res.json(loan);
  } catch (e) { next(e); }
}

// Soft-delete a loan (DRAFT only — disbursed loans are financial records).
async function remove(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.loan.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Loan not found' });
    if (existing.status !== 'DRAFT') {
      return res.status(409).json({ message: `Only a DRAFT loan can be deleted (currently ${existing.status})` });
    }
    await prisma.loan.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  } catch (e) { next(e); }
}

module.exports = {
  list, listByEmployee, get, listInstallments,
  create, update, submit, approve, reject, disburse, close, cancel, remove,
  // Phase 2 — schedule math shared with approvals/consumers.loan.js.
  _buildSchedule: buildSchedule, _fromCents: fromCents,
  // Phase 4 — pure, DB-free schedule math (FLAT/SIMPLE/ZERO/REDUCING_BALANCE) for
  // unit tests + reuse. computeSchedule({ principalMinor, annualRatePct,
  // tenureMonths, method }) → { rows, totalPayableC }.
  _computeSchedule: computeSchedule, _toCents: toCents, LOAN_INTEREST_METHODS,
};
