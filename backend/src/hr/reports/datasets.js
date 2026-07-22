'use strict';

/*
 * datasets.js — the WHITELIST dataset registry for the Reports Platform builder.
 *
 * Each dataset describes ONE queryable list surface: its columns (key/label/
 * type), its accepted filters, its groupable keys, and an async fetch() that
 * queries prisma directly — mirroring the underlying controller's where-clause
 * INCLUDING the tenant wall (businessId) AND the Feature-1 employee scope
 * (scopeWhere — the same helper hr/controllers/employee.controller.js uses, so
 * a TEAM-band Manager's report covers only their reporting sub-tree, and a
 * NONE scope matches nothing: scopeWhere(NONE) → { field: { in: [] } },
 * fail-closed by construction).
 *
 * The registry is the SINGLE source of truth for what a saved ReportDefinition
 * may reference: builder.service.js validates every definition (dataset key,
 * column keys, filter keys, groupBy) against it, so nothing outside this file
 * is ever queryable. This generalises the statutory-registers pattern
 * (RegisterDefinition.columns descriptor + sources.js whitelist + projector).
 *
 * Value normalisation: fetch() returns PLAIN rows keyed by column key —
 * Decimals → Number (major units), Dates left as Date (formatted at export
 * time by export/tabular.js), enums as strings. No money math happens here.
 *
 * Column types: 'string' | 'date' | 'number' | 'money' | 'enum' (enumValues).
 */

const prisma = require('../../core/lib/prisma');
const { scopeWhere } = require('../lib/scopeResolver');

const MAX_PAGE_SIZE = 10000; // hard cap per fetch (builder folds in memory)

// ── shared helpers ───────────────────────────────────────────────────────────

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function empName(e) {
  if (!e) return null;
  return [e.firstName, e.lastName].filter(Boolean).join(' ') || null;
}

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clampPaging(page, pageSize) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(pageSize, 10) || 50));
  return { skip: (p - 1) * ps, take: ps };
}

/** Uppercase an enum-ish filter value and keep it only when whitelisted. */
function normEnum(value, allowed) {
  if (value == null || value === '') return undefined;
  const s = String(value).toUpperCase().replace(/[-\s]+/g, '_');
  return allowed.includes(s) ? s : undefined;
}

const EMP_SELECT = { select: { code: true, firstName: true, lastName: true } };

// Standard employee identity columns shared by most datasets.
const EMP_COLS = [
  { key: 'employeeCode', label: 'Employee code', type: 'string' },
  { key: 'employeeName', label: 'Employee name', type: 'string' },
];

// ── the registry ─────────────────────────────────────────────────────────────

const EMPLOYEE_STATUS = ['PRE_HIRE', 'ONBOARDING', 'PROBATION', 'ACTIVE', 'ON_NOTICE', 'TERMINATED', 'RETIRED', 'ABSCONDED', 'SUSPENDED'];
const ATTENDANCE_STATUS = ['PRESENT', 'ABSENT', 'HALF_DAY', 'ON_LEAVE', 'WEEKLY_OFF', 'HOLIDAY', 'WORK_FROM_HOME', 'ON_DUTY', 'HOLIDAY_WORKED', 'MISSING_PUNCH'];
const LEAVE_TXN_STATUS = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN', 'AVAILED'];
const EXPENSE_STATUS = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'REIMBURSED', 'CANCELLED'];
const LOAN_STATUS = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'DISBURSED', 'CLOSED', 'CANCELLED'];
const LOAN_TYPE = ['LOAN', 'ADVANCE'];
const ASSET_ASSIGNMENT_STATUS = ['ASSIGNED', 'RETURNED', 'LOST', 'DAMAGED', 'PENDING_RECOVERY'];
const ASSET_CATEGORY = ['LAPTOP', 'DESKTOP', 'MOBILE', 'MONITOR', 'ACCESSORY', 'SIM', 'VEHICLE', 'FURNITURE', 'ID_CARD', 'ACCESS_CARD', 'SOFTWARE_LICENSE', 'OTHER'];
const TICKET_STATUS = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_EMPLOYEE', 'RESOLVED', 'CLOSED', 'REOPENED', 'CANCELLED'];
const TICKET_PRIORITY = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const POINTS_REASON = ['RECOGNITION', 'AWARD', 'REDEMPTION', 'EXPIRY', 'ADJUSTMENT', 'REVERSAL'];

const DATASETS = {

  // 1 ── Employee directory (mirrors hr/controllers/employee.controller.js list) ──
  employees: {
    key: 'employees',
    label: 'Employees',
    columns: [
      { key: 'code', label: 'Employee code', type: 'string' },
      { key: 'firstName', label: 'First name', type: 'string' },
      { key: 'lastName', label: 'Last name', type: 'string' },
      { key: 'workEmail', label: 'Work email', type: 'string' },
      { key: 'phone', label: 'Phone', type: 'string' },
      { key: 'status', label: 'Status', type: 'enum', enumValues: EMPLOYEE_STATUS },
      { key: 'hireDate', label: 'Hire date', type: 'date' },
      { key: 'terminationDate', label: 'Termination date', type: 'date' },
      { key: 'departmentName', label: 'Department', type: 'string' },
      { key: 'designationName', label: 'Designation', type: 'string' },
      { key: 'entityName', label: 'Entity', type: 'string' },
    ],
    filters: [
      { key: 'status', label: 'Status', type: 'enum', options: EMPLOYEE_STATUS },
      { key: 'q', label: 'Search (name / code / email)', type: 'string' },
    ],
    groupable: ['status', 'departmentName', 'designationName', 'entityName'],
    async fetch({ businessId, scope, filters = {}, page, pageSize }) {
      const where = { businessId, deletedAt: null, ...scopeWhere(scope, 'id') };
      const status = normEnum(filters.status, EMPLOYEE_STATUS);
      if (status) where.status = status;
      if (filters.q) {
        const q = String(filters.q).trim();
        if (q) {
          where.OR = [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { code: { contains: q, mode: 'insensitive' } },
            { workEmail: { contains: q, mode: 'insensitive' } },
          ];
        }
      }
      const { skip, take } = clampPaging(page, pageSize);
      const [total, items] = await Promise.all([
        prisma.employee.count({ where }),
        prisma.employee.findMany({
          where,
          orderBy: { code: 'asc' },
          skip,
          take,
          select: {
            code: true, firstName: true, lastName: true, workEmail: true, phone: true,
            status: true, hireDate: true, terminationDate: true,
            employmentRecords: {
              where: { isCurrent: true },
              take: 1,
              orderBy: { effectiveFrom: 'desc' },
              select: {
                department: { select: { name: true } },
                designation: { select: { title: true } }, // Designation uses `title`, not `name`
                entity: { select: { legalName: true, tradeName: true } },
              },
            },
          },
        }),
      ]);
      const rows = items.map((e) => {
        const rec = e.employmentRecords && e.employmentRecords[0];
        return {
          code: e.code,
          firstName: e.firstName,
          lastName: e.lastName,
          workEmail: e.workEmail,
          phone: e.phone,
          status: e.status,
          hireDate: toDate(e.hireDate),
          terminationDate: toDate(e.terminationDate),
          departmentName: rec && rec.department ? rec.department.name : null,
          designationName: rec && rec.designation ? rec.designation.title : null,
          entityName: rec && rec.entity ? (rec.entity.tradeName || rec.entity.legalName) : null,
        };
      });
      return { rows, total };
    },
  },

  // 2 ── Daily attendance rows (mirrors the attendance summary from/to surface) ──
  attendance_days: {
    key: 'attendance_days',
    label: 'Attendance (daily)',
    columns: [
      ...EMP_COLS,
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'status', label: 'Status', type: 'enum', enumValues: ATTENDANCE_STATUS },
      { key: 'firstIn', label: 'First in', type: 'string' },
      { key: 'lastOut', label: 'Last out', type: 'string' },
      { key: 'workedMinutes', label: 'Worked (min)', type: 'number' },
      { key: 'breakMinutes', label: 'Break (min)', type: 'number' },
      { key: 'overtimeMinutes', label: 'Overtime (min)', type: 'number' },
      { key: 'lopFraction', label: 'LOP fraction', type: 'number' },
    ],
    filters: [
      { key: 'from', label: 'From date', type: 'date' },
      { key: 'to', label: 'To date', type: 'date' },
      { key: 'status', label: 'Status', type: 'enum', options: ATTENDANCE_STATUS },
      { key: 'employeeId', label: 'Employee', type: 'string' },
    ],
    groupable: ['status', 'employeeCode', 'employeeName', 'date'],
    async fetch({ businessId, scope, filters = {}, page, pageSize }) {
      const where = { businessId, ...scopeWhere(scope, 'employeeId') };
      const status = normEnum(filters.status, ATTENDANCE_STATUS);
      if (status) where.status = status;
      if (filters.employeeId) where.employeeId = String(filters.employeeId);
      const from = toDate(filters.from);
      const to = toDate(filters.to);
      if (from || to) where.date = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
      const { skip, take } = clampPaging(page, pageSize);
      const [total, items] = await Promise.all([
        prisma.attendance.count({ where }),
        prisma.attendance.findMany({
          where,
          orderBy: [{ date: 'desc' }, { employeeId: 'asc' }],
          skip,
          take,
          include: { employee: EMP_SELECT },
        }),
      ]);
      const hhmm = (d) => (d ? new Date(d).toISOString().slice(11, 16) : null);
      const rows = items.map((a) => ({
        employeeCode: a.employee ? a.employee.code : null,
        employeeName: empName(a.employee),
        date: toDate(a.date),
        status: a.status,
        firstIn: hhmm(a.firstIn),
        lastOut: hhmm(a.lastOut),
        workedMinutes: a.workedMinutes,
        breakMinutes: a.breakMinutes,
        overtimeMinutes: a.overtimeMinutes,
        lopFraction: toNumber(a.lopFraction),
      }));
      return { rows, total };
    },
  },

  // 3 ── Leave requests = APPLICATION LeaveTransactions (employeeId/status/leaveTypeId) ──
  leave_requests: {
    key: 'leave_requests',
    label: 'Leave requests',
    columns: [
      ...EMP_COLS,
      { key: 'leaveTypeName', label: 'Leave type', type: 'string' },
      { key: 'startDate', label: 'Start date', type: 'date' },
      { key: 'endDate', label: 'End date', type: 'date' },
      { key: 'quantity', label: 'Quantity', type: 'number' },
      { key: 'unit', label: 'Unit', type: 'string' },
      { key: 'status', label: 'Status', type: 'enum', enumValues: LEAVE_TXN_STATUS },
      { key: 'appliedAt', label: 'Applied at', type: 'date' },
      { key: 'decidedAt', label: 'Decided at', type: 'date' },
    ],
    filters: [
      { key: 'employeeId', label: 'Employee', type: 'string' },
      { key: 'status', label: 'Status', type: 'enum', options: LEAVE_TXN_STATUS },
      { key: 'leaveTypeId', label: 'Leave type', type: 'string' },
      { key: 'from', label: 'Start from', type: 'date' },
      { key: 'to', label: 'Start to', type: 'date' },
    ],
    groupable: ['status', 'leaveTypeName', 'employeeCode', 'employeeName'],
    async fetch({ businessId, scope, filters = {}, page, pageSize }) {
      const where = {
        businessId,
        txnType: 'APPLICATION',
        ...scopeWhere(scope, 'employeeId'),
      };
      const status = normEnum(filters.status, LEAVE_TXN_STATUS);
      if (status) where.status = status;
      if (filters.employeeId) where.employeeId = String(filters.employeeId);
      if (filters.leaveTypeId) where.leaveTypeId = String(filters.leaveTypeId);
      const from = toDate(filters.from);
      const to = toDate(filters.to);
      if (from || to) where.startDate = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
      const { skip, take } = clampPaging(page, pageSize);
      const [total, items] = await Promise.all([
        prisma.leaveTransaction.count({ where }),
        prisma.leaveTransaction.findMany({
          where,
          orderBy: [{ startDate: 'desc' }],
          skip,
          take,
          include: { employee: EMP_SELECT, leaveType: { select: { name: true } } },
        }),
      ]);
      const rows = items.map((t) => ({
        employeeCode: t.employee ? t.employee.code : null,
        employeeName: empName(t.employee),
        leaveTypeName: t.leaveType ? t.leaveType.name : null,
        startDate: toDate(t.startDate),
        endDate: toDate(t.endDate),
        quantity: Math.abs(toNumber(t.quantity) || 0),
        unit: t.unit,
        status: t.status,
        appliedAt: toDate(t.appliedAt),
        decidedAt: toDate(t.decidedAt),
      }));
      return { rows, total };
    },
  },

  // 4 ── Leave balances (period ledger snapshot) ──
  leave_balances: {
    key: 'leave_balances',
    label: 'Leave balances',
    columns: [
      ...EMP_COLS,
      { key: 'leaveTypeName', label: 'Leave type', type: 'string' },
      { key: 'periodCode', label: 'Period', type: 'string' },
      { key: 'unit', label: 'Unit', type: 'string' },
      { key: 'opening', label: 'Opening', type: 'number' },
      { key: 'accrued', label: 'Accrued', type: 'number' },
      { key: 'taken', label: 'Taken', type: 'number' },
      { key: 'pendingApproval', label: 'Pending approval', type: 'number' },
      { key: 'encashed', label: 'Encashed', type: 'number' },
      { key: 'lapsed', label: 'Lapsed', type: 'number' },
      { key: 'closing', label: 'Closing', type: 'number' },
    ],
    filters: [
      { key: 'employeeId', label: 'Employee', type: 'string' },
      { key: 'leaveTypeId', label: 'Leave type', type: 'string' },
      { key: 'periodCode', label: 'Period code', type: 'string' },
    ],
    groupable: ['leaveTypeName', 'periodCode', 'employeeCode', 'employeeName'],
    async fetch({ businessId, scope, filters = {}, page, pageSize }) {
      const where = { businessId, ...scopeWhere(scope, 'employeeId') };
      if (filters.employeeId) where.employeeId = String(filters.employeeId);
      if (filters.leaveTypeId) where.leaveTypeId = String(filters.leaveTypeId);
      if (filters.periodCode) where.periodCode = String(filters.periodCode);
      const { skip, take } = clampPaging(page, pageSize);
      const [total, items] = await Promise.all([
        prisma.leaveBalance.count({ where }),
        prisma.leaveBalance.findMany({
          where,
          orderBy: [{ employeeId: 'asc' }, { periodCode: 'desc' }],
          skip,
          take,
          include: { employee: EMP_SELECT, leaveType: { select: { name: true } } },
        }),
      ]);
      const rows = items.map((b) => ({
        employeeCode: b.employee ? b.employee.code : null,
        employeeName: empName(b.employee),
        leaveTypeName: b.leaveType ? b.leaveType.name : null,
        periodCode: b.periodCode,
        unit: b.unit,
        opening: toNumber(b.opening),
        accrued: toNumber(b.accrued),
        taken: toNumber(b.taken),
        pendingApproval: toNumber(b.pendingApproval),
        encashed: toNumber(b.encashed),
        lapsed: toNumber(b.lapsed),
        closing: toNumber(b.closing),
      }));
      return { rows, total };
    },
  },

  // 5 ── Payroll lines (per run or period — mirrors reports payrollRegister scope) ──
  payroll_lines: {
    key: 'payroll_lines',
    label: 'Payroll lines',
    columns: [
      { key: 'runCode', label: 'Pay run', type: 'string' },
      { key: 'periodStart', label: 'Period start', type: 'date' },
      { key: 'periodEnd', label: 'Period end', type: 'date' },
      ...EMP_COLS,
      { key: 'payableDays', label: 'Payable days', type: 'number' },
      { key: 'lopDays', label: 'LOP days', type: 'number' },
      { key: 'grossEarnings', label: 'Gross', type: 'money' },
      { key: 'totalDeductions', label: 'Deductions', type: 'money' },
      { key: 'netPay', label: 'Net pay', type: 'money' },
      { key: 'employerCost', label: 'Employer cost', type: 'money' },
      { key: 'pfEmployee', label: 'PF (EE)', type: 'money' },
      { key: 'esiEmployee', label: 'ESI (EE)', type: 'money' },
      { key: 'pt', label: 'PT', type: 'money' },
      { key: 'tds', label: 'TDS', type: 'money' },
      { key: 'currencyCode', label: 'Currency', type: 'string' },
      { key: 'status', label: 'Line status', type: 'string' },
    ],
    filters: [
      { key: 'payRunId', label: 'Pay run', type: 'string' },
      { key: 'from', label: 'Period start from', type: 'date' },
      { key: 'to', label: 'Period start to', type: 'date' },
      { key: 'employeeId', label: 'Employee', type: 'string' },
    ],
    groupable: ['runCode', 'currencyCode', 'status', 'employeeCode', 'employeeName'],
    async fetch({ businessId, scope, filters = {}, page, pageSize }) {
      const where = { businessId, ...scopeWhere(scope, 'employeeId') };
      if (filters.payRunId) where.payRunId = String(filters.payRunId);
      if (filters.employeeId) where.employeeId = String(filters.employeeId);
      const from = toDate(filters.from);
      const to = toDate(filters.to);
      if (from || to) {
        where.payRun = { periodStart: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } };
      }
      const { skip, take } = clampPaging(page, pageSize);
      const [total, items] = await Promise.all([
        prisma.payRunLine.count({ where }),
        prisma.payRunLine.findMany({
          where,
          orderBy: [{ payRunId: 'desc' }, { employeeId: 'asc' }],
          skip,
          take,
          include: {
            employee: EMP_SELECT,
            payRun: { select: { code: true, periodStart: true, periodEnd: true } },
          },
        }),
      ]);
      const rows = items.map((l) => ({
        runCode: l.payRun ? l.payRun.code : null,
        periodStart: l.payRun ? toDate(l.payRun.periodStart) : null,
        periodEnd: l.payRun ? toDate(l.payRun.periodEnd) : null,
        employeeCode: l.employee ? l.employee.code : null,
        employeeName: empName(l.employee),
        payableDays: toNumber(l.payableDays),
        lopDays: toNumber(l.lopDays),
        grossEarnings: toNumber(l.grossEarnings),
        totalDeductions: toNumber(l.totalDeductions),
        netPay: toNumber(l.netPay),
        employerCost: toNumber(l.employerCost),
        pfEmployee: toNumber(l.pfEmployee),
        esiEmployee: toNumber(l.esiEmployee),
        pt: toNumber(l.pt),
        tds: toNumber(l.tds),
        currencyCode: l.currencyCode,
        status: l.status,
      }));
      return { rows, total };
    },
  },

  // 6 ── Expense claims (status/employeeId/categoryId — mirrors expenses list) ──
  expenses: {
    key: 'expenses',
    label: 'Expense claims',
    columns: [
      { key: 'claimNumber', label: 'Claim #', type: 'string' },
      ...EMP_COLS,
      { key: 'categoryName', label: 'Category', type: 'string' },
      { key: 'amount', label: 'Amount', type: 'money' },
      { key: 'currencyCode', label: 'Currency', type: 'string' },
      { key: 'expenseDate', label: 'Expense date', type: 'date' },
      { key: 'status', label: 'Status', type: 'enum', enumValues: EXPENSE_STATUS },
      { key: 'submittedAt', label: 'Submitted', type: 'date' },
      { key: 'decidedAt', label: 'Decided', type: 'date' },
      { key: 'reimbursedAt', label: 'Reimbursed', type: 'date' },
    ],
    filters: [
      { key: 'status', label: 'Status', type: 'enum', options: EXPENSE_STATUS },
      { key: 'employeeId', label: 'Employee', type: 'string' },
      { key: 'categoryId', label: 'Category', type: 'string' },
      { key: 'from', label: 'Expense date from', type: 'date' },
      { key: 'to', label: 'Expense date to', type: 'date' },
    ],
    groupable: ['status', 'categoryName', 'employeeCode', 'employeeName', 'currencyCode'],
    async fetch({ businessId, scope, filters = {}, page, pageSize }) {
      const where = { businessId, deletedAt: null, ...scopeWhere(scope, 'employeeId') };
      const status = normEnum(filters.status, EXPENSE_STATUS);
      if (status) where.status = status;
      if (filters.employeeId) where.employeeId = String(filters.employeeId);
      if (filters.categoryId) where.categoryId = String(filters.categoryId);
      const from = toDate(filters.from);
      const to = toDate(filters.to);
      if (from || to) where.expenseDate = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
      const { skip, take } = clampPaging(page, pageSize);
      const [total, items] = await Promise.all([
        prisma.expenseClaim.count({ where }),
        prisma.expenseClaim.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          skip,
          take,
          include: { employee: EMP_SELECT, category: { select: { name: true } } },
        }),
      ]);
      const rows = items.map((c) => ({
        claimNumber: c.claimNumber,
        employeeCode: c.employee ? c.employee.code : null,
        employeeName: empName(c.employee),
        categoryName: c.category ? c.category.name : null,
        amount: toNumber(c.amount),
        currencyCode: c.currencyCode,
        expenseDate: toDate(c.expenseDate),
        status: c.status,
        submittedAt: toDate(c.submittedAt),
        decidedAt: toDate(c.decidedAt),
        reimbursedAt: toDate(c.reimbursedAt),
      }));
      return { rows, total };
    },
  },

  // 7 ── Loans & advances (status/employeeId/loanType) ──
  loans: {
    key: 'loans',
    label: 'Loans & advances',
    columns: [
      { key: 'loanNumber', label: 'Loan #', type: 'string' },
      ...EMP_COLS,
      { key: 'loanType', label: 'Type', type: 'enum', enumValues: LOAN_TYPE },
      { key: 'principal', label: 'Principal', type: 'money' },
      { key: 'interestRate', label: 'Interest %', type: 'number' },
      { key: 'tenureMonths', label: 'Tenure (months)', type: 'number' },
      { key: 'emiAmount', label: 'EMI', type: 'money' },
      { key: 'startDate', label: 'Start date', type: 'date' },
      { key: 'status', label: 'Status', type: 'enum', enumValues: LOAN_STATUS },
      { key: 'amountRepaid', label: 'Repaid', type: 'money' },
      { key: 'outstanding', label: 'Outstanding', type: 'money' },
    ],
    filters: [
      { key: 'status', label: 'Status', type: 'enum', options: LOAN_STATUS },
      { key: 'employeeId', label: 'Employee', type: 'string' },
      { key: 'loanType', label: 'Type', type: 'enum', options: LOAN_TYPE },
    ],
    groupable: ['status', 'loanType', 'employeeCode', 'employeeName'],
    async fetch({ businessId, scope, filters = {}, page, pageSize }) {
      const where = { businessId, deletedAt: null, ...scopeWhere(scope, 'employeeId') };
      const status = normEnum(filters.status, LOAN_STATUS);
      if (status) where.status = status;
      const loanType = normEnum(filters.loanType, LOAN_TYPE);
      if (loanType) where.loanType = loanType;
      if (filters.employeeId) where.employeeId = String(filters.employeeId);
      const { skip, take } = clampPaging(page, pageSize);
      const [total, items] = await Promise.all([
        prisma.loan.count({ where }),
        prisma.loan.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          skip,
          take,
          include: { employee: EMP_SELECT },
        }),
      ]);
      const rows = items.map((l) => ({
        loanNumber: l.loanNumber,
        employeeCode: l.employee ? l.employee.code : null,
        employeeName: empName(l.employee),
        loanType: l.loanType,
        principal: toNumber(l.principal),
        interestRate: toNumber(l.interestRate),
        tenureMonths: l.tenureMonths,
        emiAmount: toNumber(l.emiAmount),
        startDate: toDate(l.startDate),
        status: l.status,
        amountRepaid: toNumber(l.amountRepaid),
        outstanding: toNumber(l.outstanding),
      }));
      return { rows, total };
    },
  },

  // 8 ── Asset assignments (who holds what — mirrors assets+assignments list) ──
  assets_assignments: {
    key: 'assets_assignments',
    label: 'Asset assignments',
    columns: [
      { key: 'assetCode', label: 'Asset code', type: 'string' },
      { key: 'assetName', label: 'Asset', type: 'string' },
      { key: 'category', label: 'Category', type: 'enum', enumValues: ASSET_CATEGORY },
      { key: 'serialNumber', label: 'Serial #', type: 'string' },
      ...EMP_COLS,
      { key: 'assignedAt', label: 'Assigned', type: 'date' },
      { key: 'returnedAt', label: 'Returned', type: 'date' },
      { key: 'status', label: 'Status', type: 'enum', enumValues: ASSET_ASSIGNMENT_STATUS },
      { key: 'conditionOut', label: 'Condition out', type: 'string' },
      { key: 'conditionIn', label: 'Condition in', type: 'string' },
    ],
    filters: [
      { key: 'status', label: 'Status', type: 'enum', options: ASSET_ASSIGNMENT_STATUS },
      { key: 'employeeId', label: 'Employee', type: 'string' },
      { key: 'category', label: 'Asset category', type: 'enum', options: ASSET_CATEGORY },
    ],
    groupable: ['status', 'category', 'employeeCode', 'employeeName'],
    async fetch({ businessId, scope, filters = {}, page, pageSize }) {
      const where = { businessId, ...scopeWhere(scope, 'employeeId') };
      const status = normEnum(filters.status, ASSET_ASSIGNMENT_STATUS);
      if (status) where.status = status;
      if (filters.employeeId) where.employeeId = String(filters.employeeId);
      const category = normEnum(filters.category, ASSET_CATEGORY);
      if (category) where.asset = { category };
      const { skip, take } = clampPaging(page, pageSize);
      const [total, items] = await Promise.all([
        prisma.assetAssignment.count({ where }),
        prisma.assetAssignment.findMany({
          where,
          orderBy: [{ assignedAt: 'desc' }],
          skip,
          take,
          include: {
            employee: EMP_SELECT,
            asset: { select: { code: true, name: true, category: true, serialNumber: true } },
          },
        }),
      ]);
      const rows = items.map((a) => ({
        assetCode: a.asset ? a.asset.code : null,
        assetName: a.asset ? a.asset.name : null,
        category: a.asset ? a.asset.category : null,
        serialNumber: a.asset ? a.asset.serialNumber : null,
        employeeCode: a.employee ? a.employee.code : null,
        employeeName: empName(a.employee),
        assignedAt: toDate(a.assignedAt),
        returnedAt: toDate(a.returnedAt),
        status: a.status,
        conditionOut: a.conditionOut,
        conditionIn: a.conditionIn,
      }));
      return { rows, total };
    },
  },

  // 9 ── Helpdesk tickets (queue analytics) ──
  helpdesk_tickets: {
    key: 'helpdesk_tickets',
    label: 'Helpdesk tickets',
    columns: [
      { key: 'code', label: 'Ticket #', type: 'string' },
      { key: 'subject', label: 'Subject', type: 'string' },
      ...EMP_COLS,
      { key: 'categoryName', label: 'Category', type: 'string' },
      { key: 'priority', label: 'Priority', type: 'enum', enumValues: TICKET_PRIORITY },
      { key: 'status', label: 'Status', type: 'enum', enumValues: TICKET_STATUS },
      { key: 'createdAt', label: 'Raised', type: 'date' },
      { key: 'firstResponseAt', label: 'First response', type: 'date' },
      { key: 'resolvedAt', label: 'Resolved', type: 'date' },
      { key: 'satisfactionRating', label: 'CSAT (1-5)', type: 'number' },
    ],
    filters: [
      { key: 'status', label: 'Status', type: 'enum', options: TICKET_STATUS },
      { key: 'priority', label: 'Priority', type: 'enum', options: TICKET_PRIORITY },
      { key: 'categoryId', label: 'Category', type: 'string' },
      { key: 'employeeId', label: 'Employee', type: 'string' },
      { key: 'from', label: 'Raised from', type: 'date' },
      { key: 'to', label: 'Raised to', type: 'date' },
    ],
    groupable: ['status', 'priority', 'categoryName', 'employeeCode', 'employeeName'],
    async fetch({ businessId, scope, filters = {}, page, pageSize }) {
      const where = { businessId, deletedAt: null, ...scopeWhere(scope, 'employeeId') };
      const status = normEnum(filters.status, TICKET_STATUS);
      if (status) where.status = status;
      const priority = normEnum(filters.priority, TICKET_PRIORITY);
      if (priority) where.priority = priority;
      if (filters.categoryId) where.categoryId = String(filters.categoryId);
      if (filters.employeeId) where.employeeId = String(filters.employeeId);
      const from = toDate(filters.from);
      const to = toDate(filters.to);
      if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
      const { skip, take } = clampPaging(page, pageSize);
      const [total, items] = await Promise.all([
        prisma.helpdeskTicket.count({ where }),
        prisma.helpdeskTicket.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          skip,
          take,
          include: { employee: EMP_SELECT, category: { select: { name: true } } },
        }),
      ]);
      const rows = items.map((t) => ({
        code: t.code,
        subject: t.subject,
        employeeCode: t.employee ? t.employee.code : null,
        employeeName: empName(t.employee),
        categoryName: t.category ? t.category.name : null,
        priority: t.priority,
        status: t.status,
        createdAt: toDate(t.createdAt),
        firstResponseAt: toDate(t.firstResponseAt),
        resolvedAt: toDate(t.resolvedAt),
        satisfactionRating: t.satisfactionRating,
      }));
      return { rows, total };
    },
  },

  // 10 ── Recognition points ledger (R&R analytics) ──
  recognition_ledger: {
    key: 'recognition_ledger',
    label: 'Recognition points ledger',
    columns: [
      ...EMP_COLS,
      { key: 'points', label: 'Points', type: 'number' },
      { key: 'reason', label: 'Reason', type: 'enum', enumValues: POINTS_REASON },
      { key: 'refType', label: 'Ref type', type: 'string' },
      { key: 'note', label: 'Note', type: 'string' },
      { key: 'expiresAt', label: 'Expires', type: 'date' },
      { key: 'createdAt', label: 'Posted', type: 'date' },
    ],
    filters: [
      { key: 'employeeId', label: 'Employee', type: 'string' },
      { key: 'reason', label: 'Reason', type: 'enum', options: POINTS_REASON },
      { key: 'from', label: 'Posted from', type: 'date' },
      { key: 'to', label: 'Posted to', type: 'date' },
    ],
    groupable: ['reason', 'refType', 'employeeCode', 'employeeName'],
    async fetch({ businessId, scope, filters = {}, page, pageSize }) {
      const where = { businessId, ...scopeWhere(scope, 'employeeId') };
      if (filters.employeeId) where.employeeId = String(filters.employeeId);
      const reason = normEnum(filters.reason, POINTS_REASON);
      if (reason) where.reason = reason;
      const from = toDate(filters.from);
      const to = toDate(filters.to);
      if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
      const { skip, take } = clampPaging(page, pageSize);
      const [total, items] = await Promise.all([
        prisma.pointsLedgerEntry.count({ where }),
        prisma.pointsLedgerEntry.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          skip,
          take,
          include: { employee: EMP_SELECT },
        }),
      ]);
      const rows = items.map((e) => ({
        employeeCode: e.employee ? e.employee.code : null,
        employeeName: empName(e.employee),
        points: e.points,
        reason: e.reason,
        refType: e.refType,
        note: e.note,
        expiresAt: toDate(e.expiresAt),
        createdAt: toDate(e.createdAt),
      }));
      return { rows, total };
    },
  },
};

const DATASET_KEYS = Object.freeze(Object.keys(DATASETS));

function getDataset(key) {
  return DATASETS[key] || null;
}

/** Registry metadata for the builder UI (no fetch functions exposed). */
function datasetsMeta() {
  return DATASET_KEYS.map((k) => {
    const d = DATASETS[k];
    return {
      key: d.key,
      label: d.label,
      columns: d.columns.map((c) => ({ key: c.key, label: c.label, type: c.type || 'string', ...(c.enumValues ? { enumValues: c.enumValues } : {}) })),
      filters: d.filters.map((f) => ({ key: f.key, label: f.label, type: f.type || 'string', ...(f.options ? { options: f.options } : {}) })),
      groupable: [...d.groupable],
    };
  });
}

module.exports = { DATASETS, DATASET_KEYS, getDataset, datasetsMeta, MAX_PAGE_SIZE };
