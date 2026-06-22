'use strict';

/**
 * tenant-isolation.idor.test.js — LIVE cross-tenant / IDOR proof.
 *
 * Runs against the ISOLATED hr_test schema (DATABASE_URL="$HR_URL"). It:
 *   1. Ensures a SECOND tenant ('globex') exists with one employee, one entity,
 *      a COMPUTED pay run, a pay-run line, and a GENERATED payslip.
 *   2. Builds a demo-operator context (req.user.businessId = demo) and asserts,
 *      through the SERVICE + CONTROLLER layer (not raw SQL), that demo CANNOT
 *      read/list/get ANY of globex's employees, pay runs, or payslips.
 *
 * Every assertion proves the cross-tenant read returns empty / 404 — and, where
 * a list is returned, that NONE of the rows belong to globex. A leak (a globex
 * row visible to demo, or a 200 instead of 404) fails the run with a non-zero
 * exit code.
 *
 * This is a plain Node script (no jest dependency) so it can run directly with
 * `DATABASE_URL="$HR_URL" node src/hr/__tests__/tenant-isolation.idor.test.js`.
 */

const prisma = require('../../core/lib/prisma');
const employeeController = require('../controllers/employee.controller');
const compensationController = require('../controllers/compensation.controller');
const payrollService = require('../payroll/service');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); }
  else { failures += 1; log(`  FAIL  ${msg}`); }
}

// Minimal Express res() double — captures status + json/body.
function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  return res;
}

// Invoke a controller (req, res, next) and resolve to { statusCode, body }.
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => {
      if (err) { settled = true; return reject(err); }
      return done();
    };
    // Patch json/end to resolve after the handler responds.
    const origJson = res.json.bind(res);
    res.json = (p) => { const r = origJson(p); done(); return r; };
    const origEnd = res.end.bind(res);
    res.end = () => { const r = origEnd(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

async function ensureGlobex() {
  const slug = 'globex';
  let biz = await prisma.business.findFirst({ where: { slug } });
  if (!biz) {
    biz = await prisma.business.create({
      data: { name: 'Globex Corporation', slug, region: 'IN', country: 'IN' },
    });
  }
  const businessId = biz.id;

  let entity = await prisma.entity.findFirst({ where: { businessId } });
  if (!entity) {
    entity = await prisma.entity.create({
      data: {
        businessId,
        code: 'GLBX-HQ',
        legalName: 'Globex Corporation Pvt Ltd',
        countryCode: 'IN',
        payCurrency: 'INR',
        timezone: 'Asia/Kolkata',
        taxYearStartMonth: 4,
        activeFrom: new Date('2026-04-01'),
      },
    });
  }

  let employee = await prisma.employee.findFirst({ where: { businessId, deletedAt: null } });
  if (!employee) {
    employee = await prisma.employee.create({
      data: {
        businessId,
        code: 'GLBX-0001',
        firstName: 'Hank',
        lastName: 'Scorpio',
        workEmail: 'hank@globex.test',
        status: 'ACTIVE',
      },
    });
  }

  let cal = await prisma.payCalendar.findFirst({ where: { businessId, entityId: entity.id } });
  if (!cal) {
    cal = await prisma.payCalendar.create({
      data: {
        businessId,
        entityId: entity.id,
        code: 'GLBX-MON',
        name: 'Globex Monthly',
        frequency: 'MONTHLY',
        payDayRule: 'FIXED_DOM',
        payDayValue: 30,
        cutoffDayRule: 'FIXED_DOM',
        cutoffDayValue: 25,
      },
    });
  }

  let payRun = await prisma.payRun.findFirst({ where: { businessId } });
  if (!payRun) {
    payRun = await prisma.payRun.create({
      data: {
        businessId,
        entityId: entity.id,
        payCalendarId: cal.id,
        code: 'PR-2026-06-GLBX',
        periodStart: new Date('2026-06-01'),
        periodEnd: new Date('2026-06-30'),
        payDate: new Date('2026-06-30'),
        sequenceInYear: 3,
        taxYear: '2026-27',
        currencyCode: 'INR',
        status: 'COMPUTED',
        headcount: 1,
      },
    });
  }

  let comp = await prisma.compensationRevision.findFirst({ where: { businessId, employeeId: employee.id } });
  if (!comp) {
    comp = await prisma.compensationRevision.create({
      data: {
        businessId,
        employeeId: employee.id,
        entityId: entity.id,
        currencyCode: 'INR',
        basis: 'CTC',
        ctcAnnual: '600000.00',
        grossMonthly: '50000.00',
        effectiveFrom: new Date('2026-04-01'),
        revisionReason: 'HIRE',
        isCurrent: true,
      },
    });
  }

  let line = await prisma.payRunLine.findFirst({ where: { businessId, payRunId: payRun.id } });
  if (!line) {
    line = await prisma.payRunLine.create({
      data: {
        businessId,
        payRunId: payRun.id,
        employeeId: employee.id,
        compensationId: comp.id,
        payableDays: '30.0000',
        grossEarnings: '50000.00',
        totalDeductions: '5000.00',
        netPay: '45000.00',
        currencyCode: 'INR',
        status: 'COMPUTED',
      },
    });
  }

  let payslip = await prisma.payslip.findFirst({ where: { businessId } });
  if (!payslip) {
    payslip = await prisma.payslip.create({
      data: {
        businessId,
        payRunId: payRun.id,
        payRunLineId: line.id,
        employeeId: employee.id,
        code: 'PS-2026-06-GLBX-0001',
        periodStart: payRun.periodStart,
        periodEnd: payRun.periodEnd,
        payDate: payRun.payDate,
        currencyCode: 'INR',
        grossEarnings: '50000.00',
        totalDeductions: '5000.00',
        netPay: '45000.00',
        snapshotJson: { net: '45000.00' },
        status: 'GENERATED',
      },
    });
  }

  return { businessId, entity, employee, payRun, payslip };
}

async function main() {
  log('\n=== Tenant-isolation / IDOR proof (LIVE hr_test) ===\n');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const globex = await ensureGlobex();
  log(`demo   businessId = ${demo.id}`);
  log(`globex businessId = ${globex.businessId}`);
  log(`globex employee   = ${globex.employee.id}`);
  log(`globex payRun     = ${globex.payRun.id}`);
  log(`globex payslip    = ${globex.payslip.id}\n`);

  // Sanity: globex really does own these rows (so an "empty" result is a true
  // isolation pass, not just an empty database).
  assert(globex.businessId !== demo.id, 'globex and demo are distinct tenants');

  // demo-operator request context. Owner role => all permissions, but every
  // query is still businessId-scoped by the controller/service.
  const demoUser = { id: 'demo-operator', businessId: demo.id, role: 'BUSINESS_ADMIN' };

  // ── EMPLOYEES ──────────────────────────────────────────────────────────────
  log('Employees:');
  {
    // list (no filter) — must never include a globex employee.
    const res = await callController(employeeController.list, { user: demoUser, query: {} });
    const items = (res.body && res.body.items) || [];
    const leaked = items.filter((e) => e.id === globex.employee.id);
    assert(res.statusCode === 200, 'employee.list returns 200 for demo');
    assert(leaked.length === 0, 'employee.list does NOT include globex employee');

    // get by globex id under demo context — must 404, never return the row.
    const resGet = await callController(employeeController.get, { user: demoUser, params: { id: globex.employee.id } });
    assert(resGet.statusCode === 404, 'employee.get(globexEmpId) → 404 for demo');
    assert(!resGet.body || !resGet.body.id, 'employee.get(globexEmpId) leaks no row body');
  }

  // ── COMPENSATION (revisions list scoped by employee + tenant) ───────────────
  log('Compensation:');
  {
    const res = await callController(compensationController.revisions.list, {
      user: demoUser, params: { employeeId: globex.employee.id },
    });
    // The employee lookup is tenant-scoped, so a globex employee is "not found".
    assert(res.statusCode === 404, 'compensation.revisions.list(globexEmpId) → 404 for demo');
  }

  // ── PAY RUNS (service layer) ────────────────────────────────────────────────
  log('Pay runs:');
  {
    const list = await payrollService.listRuns({ businessId: demo.id });
    const leaked = (list.items || []).filter((r) => r.id === globex.payRun.id);
    assert(leaked.length === 0, 'service.listRuns(demo) does NOT include globex pay run');

    let threw = false;
    try {
      await payrollService.getRun({ businessId: demo.id, payRunId: globex.payRun.id });
    } catch (err) {
      threw = true;
      assert(err && (err.statusCode === 404 || err.code === 'NOT_FOUND'),
        'service.getRun(globexRun) under demo → NOT_FOUND');
    }
    assert(threw, 'service.getRun(globexRun) under demo throws (never returns globex run)');
  }

  // ── PAYSLIPS (service layer) ────────────────────────────────────────────────
  log('Payslips:');
  {
    // getRunPayslips for globex's run id under demo → run not found (404).
    let threw = false;
    try {
      await payrollService.getRunPayslips({ businessId: demo.id, payRunId: globex.payRun.id });
    } catch (err) {
      threw = true;
      assert(err && (err.statusCode === 404 || err.code === 'NOT_FOUND'),
        'service.getRunPayslips(globexRun) under demo → NOT_FOUND');
    }
    assert(threw, 'service.getRunPayslips(globexRun) under demo throws');

    // getPayslip for globex's payslip id under demo → payslip not found (404).
    let threw2 = false;
    try {
      await payrollService.getPayslip({ businessId: demo.id, payslipId: globex.payslip.id });
    } catch (err) {
      threw2 = true;
      assert(err && (err.statusCode === 404 || err.code === 'NOT_FOUND'),
        'service.getPayslip(globexPayslip) under demo → NOT_FOUND');
    }
    assert(threw2, 'service.getPayslip(globexPayslip) under demo throws');
  }

  // ── CONTROL: globex CAN see its OWN rows (proves the data really exists) ─────
  log('Control (globex sees its own):');
  {
    const ownRun = await payrollService.getRun({ businessId: globex.businessId, payRunId: globex.payRun.id });
    assert(ownRun && ownRun.payRun && ownRun.payRun.id === globex.payRun.id,
      'globex CAN read its own pay run (data exists, scope works both ways)');
    const ownPayslip = await payrollService.getPayslip({ businessId: globex.businessId, payslipId: globex.payslip.id });
    assert(ownPayslip && ownPayslip.id === globex.payslip.id,
      'globex CAN read its own payslip');
  }

  log(`\n=== ${failures === 0 ? 'ALL ISOLATION CHECKS PASSED' : `${failures} ISOLATION CHECK(S) FAILED`} ===\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Isolation test crashed:', err);
  try { await prisma.$disconnect(); } catch (_e) { /* ignore */ }
  process.exit(2);
});
