'use strict';
// Employee loans / salary advances. Tenant-scoped by req.user.businessId and the
// owning employeeId; soft-delete via deletedAt. A Loan moves through a lifecycle
//   DRAFT → PENDING → APPROVED → DISBURSED → CLOSED   (REJECTED / CANCELLED exit)
// and carries a generated LoanInstallment (EMI) schedule. Money is Prisma Decimal
// (15,2) — amounts are passed through as numbers/strings, never parseInt'd; only
// internal schedule arithmetic uses a fixed-scale helper to avoid float drift.
const prisma = require('../../core/lib/prisma');

const LIST_SELECT = {
  id: true, loanNumber: true, employeeId: true, schemeId: true, loanType: true,
  principal: true, currencyCode: true, tenureMonths: true, emiAmount: true,
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
  'currencyCode', 'tenureMonths', 'emiAmount', 'startDate', 'reason',
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

// Build a level (equal-principal + flat-interest) repayment schedule. Interest is
// simple: rate% per annum over the full tenure, split evenly. The last row absorbs
// any rounding remainder so principal/interest/total reconcile to the cent.
function buildSchedule(loan) {
  const n = loan.tenureMonths;
  const principalC = toCents(loan.principal);
  const rate = loan.interestRate != null ? Number(loan.interestRate) : 0;
  const totalInterestC = rate > 0
    ? Math.round((principalC * rate / 100) * (n / 12))
    : 0;

  const basePrinC = Math.floor(principalC / n);
  const baseIntC = Math.floor(totalInterestC / n);
  let prinRem = principalC - basePrinC * n;
  let intRem = totalInterestC - baseIntC * n;

  const start = new Date(loan.startDate);
  const rows = [];
  for (let seq = 1; seq <= n; seq++) {
    let p = basePrinC;
    let i = baseIntC;
    if (seq === n) { p += prinRem; i += intRem; } // remainder into final row
    const due = new Date(start);
    due.setMonth(due.getMonth() + (seq - 1));
    rows.push({
      seq,
      dueDate: due,
      principalComponent: fromCents(p),
      interestComponent: fromCents(i),
      amount: fromCents(p + i),
    });
  }
  return { rows, totalPayableC: principalC + totalInterestC };
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
    if (!(await employeeInTenant(businessId, employeeId))) {
      return res.status(400).json({ message: 'employeeId does not reference an employee in this business' });
    }
    // If a scheme is supplied, validate tenant ownership and snapshot its rate.
    let interestRate = req.body.interestRate;
    if (req.body.schemeId) {
      const scheme = await prisma.loanScheme.findFirst({
        where: { id: req.body.schemeId, businessId, deletedAt: null },
        select: { id: true, interestRate: true, loanType: true },
      });
      if (!scheme) return res.status(400).json({ message: 'schemeId does not reference a scheme in this business' });
      if (interestRate == null) interestRate = scheme.interestRate;
    }

    const data = { ...pickWritable(req.body), businessId, status: 'DRAFT' };
    if (interestRate != null) data.interestRate = interestRate;

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
    const loan = await prisma.loan.update({
      where: { id: req.params.id },
      data: { status: 'PENDING', submittedAt: new Date() },
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
};
