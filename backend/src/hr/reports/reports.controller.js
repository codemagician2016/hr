'use strict';

/**
 * reports.controller.js — HTTP layer for the HR reports/analytics surface.
 *
 * Thin prisma↔pure-fn wiring: each handler fetches tenant-scoped rows
 * (req.user.businessId) and folds them with the pure builders in
 * aggregations.js. No money math lives here.
 *
 * Mounted at /api/hr/reports, RBAC: canViewPayrollReports (see reports.routes.js).
 */

const prisma = require('../../core/lib/prisma');
const agg = require('./aggregations');
const { scopeWhere } = require('../lib/scopeResolver');

function handleError(res, err) {
  const status = err && err.statusCode ? err.statusCode : (err && err.code === 'NOT_FOUND' ? 404 : 500);
  if (status === 500) {
    // eslint-disable-next-line no-console
    console.error('[reports.controller]', err && err.stack ? err.stack : err);
  }
  return res.status(status).json({ message: err && err.message ? err.message : 'Internal error' });
}

function notFound(message) {
  const e = new Error(message || 'Not found');
  e.statusCode = 404;
  e.code = 'NOT_FOUND';
  return e;
}

/** Resolve a pay run for the tenant, or throw 404. */
async function loadRun(businessId, payRunId) {
  const run = await prisma.payRun.findFirst({
    where: { id: payRunId, businessId },
    include: { entity: { select: { id: true, code: true, legalName: true, tradeName: true, countryCode: true, payCurrency: true } } },
  });
  if (!run) throw notFound('Pay run not found.');
  return run;
}

// ── List runs (selector for the register/statutory tabs) ──────────────────────
async function listRuns(req, res) {
  try {
    const { businessId } = req.user;
    const { entityId } = req.query || {};
    const where = { businessId };
    if (entityId) where.entityId = entityId;
    const runs = await prisma.payRun.findMany({
      where,
      orderBy: [{ periodStart: 'desc' }, { code: 'asc' }],
      take: 200,
      include: { entity: { select: { id: true, code: true, legalName: true, tradeName: true, countryCode: true, payCurrency: true } } },
    });
    res.json({
      items: runs.map((r) => ({
        id: r.id,
        code: r.code,
        status: r.status,
        type: r.type,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        payDate: r.payDate,
        currencyCode: r.currencyCode,
        headcount: r.headcount,
        entityId: r.entityId,
        entityName: r.entity ? (r.entity.tradeName || r.entity.legalName) : null,
        countryCode: r.entity ? r.entity.countryCode : null,
      })),
    });
  } catch (err) { handleError(res, err); }
}

// ── 1. Payroll register ───────────────────────────────────────────────────────
async function payrollRegister(req, res) {
  try {
    const { businessId } = req.user;
    const run = await loadRun(businessId, req.params.id);
    // Feature 1: scope the register to the actor's reporting sub-tree.
    const lines = await prisma.payRunLine.findMany({
      where: { businessId, payRunId: run.id, ...scopeWhere(req.scope, 'employeeId') },
      include: {
        employee: { select: { id: true, code: true, firstName: true, lastName: true } },
        payslip: { select: { id: true, code: true, netPay: true } },
      },
      orderBy: { employee: { code: 'asc' } },
    });
    const register = agg.buildPayrollRegister({ run, lines });
    register.run.entityName = run.entity ? (run.entity.tradeName || run.entity.legalName) : null;
    register.run.countryCode = run.entity ? run.entity.countryCode : null;
    res.json(register);
  } catch (err) { handleError(res, err); }
}

// ── 2. Statutory summary ──────────────────────────────────────────────────────
async function statutorySummary(req, res) {
  try {
    const { businessId } = req.user;
    const run = await loadRun(businessId, req.params.id);
    // Feature 1: scope the statutory roll-up to the actor's reporting sub-tree.
    const lines = await prisma.payRunLine.findMany({
      where: { businessId, payRunId: run.id, ...scopeWhere(req.scope, 'employeeId') },
      select: {
        currencyCode: true,
        pfEmployee: true, pfEmployer: true, esiEmployee: true, esiEmployer: true, pt: true, tds: true,
        paye: true, kiwiSaverEmployee: true, kiwiSaverEmployer: true, esct: true, accLevy: true, studentLoan: true,
      },
    });
    const countryCode = run.entity ? run.entity.countryCode : 'IN';
    const taxPeriod = run.taxYear && run.periodStart
      ? new Date(run.periodStart).toISOString().slice(0, 7)
      : null;
    const summary = agg.buildStatutorySummary({ lines, countryCode, currencyCode: run.currencyCode, taxPeriod });
    summary.run = { id: run.id, code: run.code, status: run.status, periodStart: run.periodStart, periodEnd: run.periodEnd };
    summary.entityName = run.entity ? (run.entity.tradeName || run.entity.legalName) : null;
    res.json(summary);
  } catch (err) { handleError(res, err); }
}

// ── 3. Headcount & attrition ──────────────────────────────────────────────────
async function headcount(req, res) {
  try {
    const { businessId } = req.user;
    const { from, to, groupBy } = req.query || {};
    // Feature 1: scope headcount/attrition to the actor's reporting sub-tree
    // (employee table is keyed on `id`).
    // Pull active employment segments to attach department/entity to each employee.
    const employees = await prisma.employee.findMany({
      where: { businessId, deletedAt: null, ...scopeWhere(req.scope, 'id') },
      select: {
        id: true, status: true, isActive: true, hireDate: true, terminationDate: true,
        employmentRecords: {
          where: { isCurrent: true },
          take: 1,
          orderBy: { effectiveFrom: 'desc' },
          select: {
            entityId: true,
            departmentId: true,
            entity: { select: { code: true, legalName: true, tradeName: true } },
            department: { select: { name: true } },
          },
        },
      },
    });
    const enriched = employees.map((e) => {
      const rec = e.employmentRecords && e.employmentRecords[0];
      return {
        id: e.id,
        status: e.status,
        isActive: e.isActive,
        hireDate: e.hireDate,
        terminationDate: e.terminationDate,
        entityId: rec ? rec.entityId : null,
        entityName: rec && rec.entity ? (rec.entity.tradeName || rec.entity.legalName || rec.entity.code) : null,
        departmentId: rec ? rec.departmentId : null,
        departmentName: rec && rec.department ? rec.department.name : null,
      };
    });
    const report = agg.buildHeadcount({ employees: enriched, periodStart: from, periodEnd: to, groupBy });
    res.json(report);
  } catch (err) { handleError(res, err); }
}

// ── 4. Leave liability ────────────────────────────────────────────────────────
async function leaveLiability(req, res) {
  try {
    const { businessId } = req.user;
    const { periodCode } = req.query || {};
    // Feature 1: scope leave liability to the actor's reporting sub-tree.
    const where = { businessId, ...scopeWhere(req.scope, 'employeeId') };
    if (periodCode) where.periodCode = periodCode;
    const balances = await prisma.leaveBalance.findMany({
      where,
      select: {
        employeeId: true,
        leaveTypeId: true,
        unit: true,
        closing: true,
        nzAccruedGrossEarnings: true,
        leaveType: { select: { name: true } },
      },
    });

    // Per-employee daily rate from their current compensation's annual/monthly
    // CTC. We approximate the encashment day-rate as monthlyGross / 30; NZ
    // annual leave uses its pre-valued nzAccruedGrossEarnings instead.
    const employeeIds = [...new Set(balances.map((b) => b.employeeId))];
    const comps = employeeIds.length
      ? await prisma.compensationRevision.findMany({
          where: { businessId, employeeId: { in: employeeIds }, isCurrent: true },
          select: { employeeId: true, grossMonthly: true, ctcAnnual: true, currencyCode: true },
        }).catch(() => [])
      : [];
    const rateByEmp = new Map();
    for (const c of comps) {
      const monthly = c.grossMonthly != null ? agg.toNumber(c.grossMonthly)
        : c.ctcAnnual != null ? agg.toNumber(c.ctcAnnual) / 12 : 0;
      rateByEmp.set(c.employeeId, { dayRate: monthly / 30, currencyCode: c.currencyCode });
    }

    const enriched = balances.map((b) => {
      const rate = rateByEmp.get(b.employeeId) || {};
      return {
        employeeId: b.employeeId,
        leaveTypeId: b.leaveTypeId,
        leaveTypeName: b.leaveType ? b.leaveType.name : null,
        unit: b.unit,
        closing: b.closing,
        nzAccruedGrossEarnings: b.nzAccruedGrossEarnings,
        dayRate: rate.dayRate || 0,
        currencyCode: rate.currencyCode,
      };
    });

    const report = agg.buildLeaveLiability({ balances: enriched });
    res.json(report);
  } catch (err) { handleError(res, err); }
}

module.exports = {
  listRuns,
  payrollRegister,
  statutorySummary,
  headcount,
  leaveLiability,
};
