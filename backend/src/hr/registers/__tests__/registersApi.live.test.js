'use strict';

/*
 * registersApi.live.test.js — LIVE (hr_test) proof of the Feature 32 controller +
 * frozen-source loaders against real Prisma rows. Builds a tenant with:
 *   - a LOCKED pay run + its PayRunLine + PayRunLineComponent + AttendancePayInput
 *     + daily Attendance rows (the FROZEN sources);
 *   - a DRAFT pay run for a second period (to prove the NOT_FROZEN gate);
 *   - a second tenant (to prove cross-tenant isolation).
 *
 * Asserts: catalog applicability; preview reconciles to the frozen PayRunLine to
 * the paise; muster reflects the frozen attendance; the DRAFT period → frozen:false
 * (never a recomputed row); export writes a RegisterExport + audit + fileHash;
 * seed is idempotent; cross-tenant access 404s.
 *
 *   DATABASE_URL="$HR_TEST_URL" node src/hr/registers/__tests__/registersApi.live.test.js
 *
 * Calls the controller handlers directly with mock req/res (the router only wires
 * protect + requirePermission + scope middleware, asserted by inspection).
 */

const prisma = require('../../../core/lib/prisma');
const ctrl = require('../registers.controller');

let failures = 0;
function ok(cond, msg) { if (cond) { console.log(`  PASS  ${msg}`); } else { failures += 1; console.log(`  FAIL  ${msg}`); } }

const PFX = 'F32API';
const BIZ = `${PFX}-biz-1`;
const BIZ2 = `${PFX}-biz-2`;
const ENT = `${PFX}-ent-1`;
const ENT2 = `${PFX}-ent-2`;
const CAL = `${PFX}-cal-1`;
const RUN_LOCKED = `${PFX}-run-locked`;
const RUN_DRAFT = `${PFX}-run-draft`;
const DESIG = `${PFX}-desig`;
const E1 = `${PFX}-emp-1`;
const E2 = `${PFX}-emp-2`;

function mockRes() {
  return {
    statusCode: 200, body: null, headers: {}, sent: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    send(b) { this.sent = b; return this; },
  };
}
async function call(handler, { user, params = {}, query = {}, body = {}, scope } = {}) {
  const res = mockRes();
  await handler({ user, params, query, body, scope: scope || { kind: 'ALL' } }, res);
  return res;
}

const ef = new Date(Date.UTC(2020, 3, 1));
const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d));

async function teardown() {
  for (const b of [BIZ, BIZ2]) {
    await prisma.registerExport.deleteMany({ where: { businessId: b } }).catch(() => {});
    await prisma.registerDefinition.deleteMany({ where: { businessId: b } }).catch(() => {});
    await prisma.payRunLineComponent.deleteMany({ where: { businessId: b } }).catch(() => {});
    await prisma.payRunLine.deleteMany({ where: { businessId: b } }).catch(() => {});
    await prisma.attendancePayInput.deleteMany({ where: { businessId: b } }).catch(() => {});
    await prisma.attendance.deleteMany({ where: { businessId: b } }).catch(() => {});
    await prisma.payRun.deleteMany({ where: { businessId: b } }).catch(() => {});
    await prisma.payCalendar.deleteMany({ where: { businessId: b } }).catch(() => {});
    await prisma.statutoryProfile.deleteMany({ where: { businessId: b } }).catch(() => {});
    await prisma.employmentRecord.deleteMany({ where: { businessId: b } }).catch(() => {});
    await prisma.designation.deleteMany({ where: { businessId: b } }).catch(() => {});
    await prisma.statutoryRegistration.deleteMany({ where: { businessId: b } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { businessId: b } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { businessId: b } }).catch(() => {});
    await prisma.entity.deleteMany({ where: { businessId: b } }).catch(() => {});
    await prisma.business.deleteMany({ where: { id: b } }).catch(() => {});
  }
}

async function setup() {
  await teardown();
  await prisma.business.create({ data: { id: BIZ, name: `${BIZ} Pvt`, slug: `${PFX.toLowerCase()}-1` } });
  await prisma.business.create({ data: { id: BIZ2, name: `${BIZ2} Pvt`, slug: `${PFX.toLowerCase()}-2` } });
  const mkEnt = (id, biz) => prisma.entity.create({ data: { id, businessId: biz, code: `${id}-HQ`, legalName: id, countryCode: 'IN', payCurrency: 'INR', stateCode: 'MH', timezone: 'Asia/Kolkata', activeFrom: ef, pan: 'AAACA1234A', tan: 'PNEA01234B' } });
  await mkEnt(ENT, BIZ);
  await mkEnt(ENT2, BIZ2);

  // Applicability registrations: S&E(MH) + EPF + ESI.
  await prisma.statutoryRegistration.createMany({
    data: [
      { businessId: BIZ, entityId: ENT, kind: 'SHOPS_ESTABLISHMENT', number: 'SE-N', stateCode: 'MH', effectiveFrom: ef, isActive: true },
      { businessId: BIZ, entityId: ENT, kind: 'EPF', number: 'EPF-N', effectiveFrom: ef, isActive: true },
      { businessId: BIZ, entityId: ENT, kind: 'ESI', number: 'ESI-N', effectiveFrom: ef, isActive: true },
    ],
  });

  await prisma.designation.create({ data: { id: DESIG, businessId: BIZ, code: 'ENG', title: 'Engineer' } });

  // Two employees with statutory profiles + current employment records on ENT.
  const mkEmp = async (id, code, fn, ln) => {
    await prisma.employee.create({ data: { id, businessId: BIZ, code, firstName: fn, lastName: ln, fatherName: `${fn} Sr`, hireDate: D(2020, 1, 1), status: 'ACTIVE' } });
    await prisma.statutoryProfile.create({ data: { businessId: BIZ, employeeId: id, countryCode: 'IN', uan: `10020030040${code.slice(-1)}`, esicIp: `3100${code.slice(-1)}`, pan: `ABCDE123${code.slice(-1)}F` } });
    await prisma.employmentRecord.create({ data: { businessId: BIZ, employeeId: id, entityId: ENT, employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE', designationId: DESIG, effectiveFrom: D(2020, 1, 1), isCurrent: true } });
  };
  await mkEmp(E1, 'EMP001', 'Asha', 'Rao');
  await mkEmp(E2, 'EMP002', 'Vikram', 'Singh');

  await prisma.payCalendar.create({ data: { id: CAL, businessId: BIZ, entityId: ENT, code: 'MC', name: 'Monthly', frequency: 'MONTHLY', payDayRule: 'LAST_WORKING_DAY', cutoffDayRule: 'LAST_WORKING_DAY' } });

  // LOCKED run for 2026-05 (the FROZEN source).
  await prisma.payRun.create({
    data: {
      id: RUN_LOCKED, businessId: BIZ, entityId: ENT, payCalendarId: CAL, code: 'PR-2026-05',
      periodStart: D(2026, 5, 1), periodEnd: D(2026, 5, 31), payDate: D(2026, 6, 1),
      sequenceInYear: 2, taxYear: '2026-27', currencyCode: 'INR', status: 'LOCKED',
    },
  });
  // DRAFT run for 2026-06 (to prove the NOT_FROZEN gate).
  await prisma.payRun.create({
    data: {
      id: RUN_DRAFT, businessId: BIZ, entityId: ENT, payCalendarId: CAL, code: 'PR-2026-06',
      periodStart: D(2026, 6, 1), periodEnd: D(2026, 6, 30), payDate: D(2026, 7, 1),
      sequenceInYear: 3, taxYear: '2026-27', currencyCode: 'INR', status: 'DRAFT',
    },
  });

  // Frozen PayRunLines for the LOCKED run.
  const mkLine = (emp, gross, pf, pt, tds, totalDed, net, payable, lop) => prisma.payRunLine.create({
    data: {
      businessId: BIZ, payRunId: RUN_LOCKED, employeeId: emp, compensationId: 'comp-x',
      payableDays: payable, lopDays: lop, overtimeHours: 5, currencyCode: 'INR',
      grossEarnings: gross, totalDeductions: totalDed, netPay: net,
      pfEmployee: pf, pfEmployer: pf, esiEmployee: 0, esiEmployer: 0, pt, lwfEmployee: 12, tds,
      pfWagesBase: 15000,
    },
  });
  const l1 = await mkLine(E1, '50000.00', '1800.00', '200.00', '2500.00', '4512.00', '45488.00', 30, 0);
  const l2 = await mkLine(E2, '75000.00', '1800.00', '200.00', '6000.00', '8012.00', '66988.00', 28, 2);
  // a Basic earning + an OT earning component on line 1 (dynamic columns + OT register).
  await prisma.payRunLineComponent.createMany({
    data: [
      { businessId: BIZ, payRunLineId: l1.id, componentId: 'c-basic', componentCode: 'BASIC', componentName: 'Basic', category: 'EARNING', amount: '25000.00', isStatutory: false, sortOrder: 1 },
      { businessId: BIZ, payRunLineId: l1.id, componentId: 'c-ot', componentCode: 'OT', componentName: 'Overtime', category: 'EARNING', amount: '1500.00', isStatutory: false, sortOrder: 9 },
      { businessId: BIZ, payRunLineId: l2.id, componentId: 'c-basic', componentCode: 'BASIC', componentName: 'Basic', category: 'EARNING', amount: '37500.00', isStatutory: false, sortOrder: 1 },
    ],
  });

  // Frozen AttendancePayInput rollups for the LOCKED run.
  await prisma.attendancePayInput.createMany({
    data: [
      { businessId: BIZ, payRunId: RUN_LOCKED, employeeId: E1, periodStart: D(2026, 5, 1), periodEnd: D(2026, 5, 31), calendarDays: 31, payableDays: 30, lopDays: 0, lwpDays: 0, absentDays: 0, paidLeaveDays: 1, weeklyOffDays: 4, holidayDays: 1, overtimeHours: 5, standardDays: 30 },
      { businessId: BIZ, payRunId: RUN_LOCKED, employeeId: E2, periodStart: D(2026, 5, 1), periodEnd: D(2026, 5, 31), calendarDays: 31, payableDays: 28, lopDays: 2, lwpDays: 1, absentDays: 1, paidLeaveDays: 0, weeklyOffDays: 4, holidayDays: 1, overtimeHours: 0, standardDays: 30 },
    ],
  });

  // Daily frozen attendance for E1 (a few representative days in May 2026).
  await prisma.attendance.createMany({
    data: [
      { businessId: BIZ, employeeId: E1, date: D(2026, 5, 1), status: 'PRESENT', lopFraction: 0, isLocked: true },
      { businessId: BIZ, employeeId: E1, date: D(2026, 5, 2), status: 'WEEKLY_OFF', lopFraction: 0, isLocked: true },
      { businessId: BIZ, employeeId: E1, date: D(2026, 5, 3), status: 'ON_LEAVE', lopFraction: 0, isLocked: true },
      { businessId: BIZ, employeeId: E2, date: D(2026, 5, 1), status: 'ABSENT', lopFraction: 1, isLocked: true },
      { businessId: BIZ, employeeId: E2, date: D(2026, 5, 2), status: 'ON_LEAVE', lopFraction: 1, isLocked: true },
    ],
  });
}

const USER = { id: 'u-admin', businessId: BIZ };
const USER2 = { id: 'u-admin2', businessId: BIZ2 };

async function main() {
  console.log('Feature 32 — registers API LIVE (hr_test):\n');
  await setup();

  // ── 1. catalog: applicability (S&E MH ⇒ Form II; EPF ⇒ PF_ANNUAL; ESI ⇒ ESI) ─
  const cat = await call(ctrl.catalog, { user: USER, query: { entityId: ENT } });
  ok(cat.statusCode === 200 && Array.isArray(cat.body.items), 'GET /catalog → 200 items[]');
  ok(cat.body.items.some((i) => i.kind === 'MUSTER_ROLL'), 'catalog offers Muster Roll');
  ok(cat.body.items.some((i) => i.kind === 'WAGE_REGISTER'), 'catalog offers Wage Register');
  ok(cat.body.items.some((i) => i.kind === 'MUSTER_WAGE_COMBINED' && i.stateCode === 'MH'), 'catalog offers MH combined (S&E applicability)');
  ok(cat.body.items.some((i) => i.kind === 'PF_ANNUAL'), 'catalog offers PF 3A/6A (EPF applicability)');
  ok(cat.body.items.some((i) => i.kind === 'ESI_REGISTER'), 'catalog offers ESI register (ESI applicability)');

  // ── 2. seed definitions → idempotent ──
  const seed1 = await call(ctrl.seedDefinitions, { user: USER, body: { entityId: ENT } });
  ok(seed1.statusCode === 200 && seed1.body.created > 0, `seed created ${seed1.body && seed1.body.created} definitions`);
  const seed2 = await call(ctrl.seedDefinitions, { user: USER, body: { entityId: ENT } });
  ok(seed2.statusCode === 200 && seed2.body.created === 0 && seed2.body.skipped === seed1.body.created, 'seed is idempotent (2nd run creates 0, skips all)');

  // ── 3. WAGE preview reconciles to the frozen PayRunLine to the paise ──
  const wage = await call(ctrl.preview, { user: USER, query: { entityId: ENT, kind: 'WAGE_REGISTER', formCode: 'FORM_X', period: '2026-05' } });
  ok(wage.statusCode === 200 && wage.body.frozen === true, 'WAGE preview → frozen:true');
  ok(wage.body.total === 2, `WAGE preview has 2 worker rows (got ${wage.body.total})`);
  ok(wage.body.totals.gross && wage.body.totals.gross.value === 125000, `WAGE gross total = 125000 (got ${wage.body.totals.gross && wage.body.totals.gross.value})`);
  ok(wage.body.totals.net && wage.body.totals.net.value === 112476, `WAGE net total = 112476 — reconciles to the pay run (got ${wage.body.totals.net && wage.body.totals.net.value})`);
  ok(wage.body.totals.tds && wage.body.totals.tds.value === 8500, `WAGE TDS total = 8500 (got ${wage.body.totals.tds && wage.body.totals.tds.value})`);
  ok(wage.body.title && wage.body.title.pan === 'AAACA1234A', 'WAGE title block carries the entity PAN');

  // ── 4. MUSTER preview reflects the frozen attendance ──
  const muster = await call(ctrl.preview, { user: USER, query: { entityId: ENT, kind: 'MUSTER_ROLL', formCode: 'FORM_25', period: '2026-05' } });
  ok(muster.statusCode === 200 && muster.body.frozen === true, 'MUSTER preview → frozen:true');
  const dayCols = (muster.body.columns || []).filter((c) => c.daily);
  ok(dayCols.length === 31, `MUSTER has 31 day columns for May (got ${dayCols.length})`);
  const r0 = muster.body.rows[0];
  const firstDaily = muster.body.columns.findIndex((c) => c.daily);
  ok(r0.cells[firstDaily].text === 'P', 'MUSTER E1 day1 = P (frozen PRESENT)');
  ok(r0.cells[firstDaily + 1].text === 'WO', 'MUSTER E1 day2 = WO (frozen WEEKLY_OFF)');
  ok(r0.cells[firstDaily + 2].text === 'L', 'MUSTER E1 day3 = L (frozen ON_LEAVE paid)');
  // E2 row: LWP summary == frozen lwpDays (1), absent == frozen absentDays (1)
  const r1 = muster.body.rows[1];
  const lwpIdx = muster.body.columns.findIndex((c) => c.key === 'lwp');
  const absentIdx = muster.body.columns.findIndex((c) => c.key === 'absent');
  ok(r1.cells[lwpIdx].text === '1.00', 'MUSTER E2 LWP summary == frozen lwpDays (1.00)');
  ok(r1.cells[absentIdx].text === '1.00', 'MUSTER E2 Absent summary == frozen absentDays (1.00)');

  // ── 5. NOT_FROZEN gate — DRAFT period → frozen:false, never a recomputed row ──
  const draft = await call(ctrl.preview, { user: USER, query: { entityId: ENT, kind: 'WAGE_REGISTER', formCode: 'FORM_X', period: '2026-06' } });
  ok(draft.statusCode === 200 && draft.body.frozen === false, 'DRAFT period preview → frozen:false (200 with flag)');
  ok(draft.body.code === 'NOT_FROZEN' && /DRAFT|lock/i.test(draft.body.reason || ''), 'DRAFT preview carries NOT_FROZEN + a "lock the run" reason');
  ok(!draft.body.rows, 'DRAFT preview has NO recomputed rows');

  // export of a non-frozen period → 409 (never a recomputed file)
  const draftExport = await call(ctrl.exportRegister, { user: USER, query: { entityId: ENT, kind: 'WAGE_REGISTER', formCode: 'FORM_X', period: '2026-06', format: 'CSV' } });
  ok(draftExport.statusCode === 409, `export of DRAFT period → 409 (got ${draftExport.statusCode})`);

  // ── 6. export a frozen register → writes RegisterExport + audit + fileHash ──
  const exp = await call(ctrl.exportRegister, { user: USER, query: { entityId: ENT, kind: 'WAGE_REGISTER', formCode: 'FORM_X', period: '2026-05', format: 'CSV' } });
  ok(exp.statusCode === 200 && Buffer.isBuffer(exp.sent), 'CSV export → 200 with bytes');
  ok(exp.headers['X-Register-File-Hash'] && /^[0-9a-f]{64}$/.test(exp.headers['X-Register-File-Hash']), 'export sets a SHA-256 X-Register-File-Hash header');
  const exportRows = await prisma.registerExport.findMany({ where: { businessId: BIZ, kind: 'WAGE_REGISTER' } });
  ok(exportRows.length === 1 && exportRows[0].rowCount === 2 && exportRows[0].fileHash, 'a RegisterExport row was written (rowCount 2 + fileHash)');
  ok(exportRows[0].controlTotals && exportRows[0].controlTotals.net === 112476, 'RegisterExport.controlTotals.net == 112476 (paise-exact)');
  const audit = await prisma.auditLog.findFirst({ where: { businessId: BIZ, action: 'registers.export' } });
  ok(!!audit, 'an audit row (registers.export) was written');

  // re-export → same frozen source ⇒ same fileHash (reproducible)
  const exp2 = await call(ctrl.exportRegister, { user: USER, query: { entityId: ENT, kind: 'WAGE_REGISTER', formCode: 'FORM_X', period: '2026-05', format: 'CSV' } });
  ok(exp.headers['X-Register-File-Hash'] === exp2.headers['X-Register-File-Hash'], 're-export of the same frozen source ⇒ identical fileHash (reproducible)');

  // PDF export produces a valid PDF
  const pdf = await call(ctrl.exportRegister, { user: USER, query: { entityId: ENT, kind: 'MUSTER_ROLL', formCode: 'FORM_25', period: '2026-05', format: 'PDF' } });
  ok(pdf.statusCode === 200 && Buffer.isBuffer(pdf.sent) && pdf.sent.slice(0, 5).toString() === '%PDF-', 'MUSTER PDF export → valid %PDF- bytes');

  // ── 7. exports history ──
  const hist = await call(ctrl.listExports, { user: USER, query: { entityId: ENT } });
  ok(hist.statusCode === 200 && hist.body.total >= 1, `GET /exports history → ${hist.body.total} rows`);

  // ── 8. cross-tenant isolation ──
  const xt = await call(ctrl.catalog, { user: USER2, query: { entityId: ENT } }); // ENT belongs to BIZ, not BIZ2
  ok(xt.statusCode === 404, `cross-tenant catalog on another tenant's entity → 404 (got ${xt.statusCode})`);
  const xtPrev = await call(ctrl.preview, { user: USER2, query: { entityId: ENT, kind: 'WAGE_REGISTER', period: '2026-05' } });
  ok(xtPrev.statusCode === 404, `cross-tenant preview → 404 (got ${xtPrev.statusCode})`);

  // ── 9. manager data-scope narrows the worker set ──
  const scoped = await call(ctrl.preview, { user: USER, query: { entityId: ENT, kind: 'WAGE_REGISTER', formCode: 'FORM_X', period: '2026-05' }, scope: { kind: 'SUBTREE', ids: new Set([E1]) } });
  ok(scoped.body.frozen === true && scoped.body.total === 1, `manager scope narrows the wage register to 1 worker (got ${scoped.body.total})`);

  // ── 10. India gate: an NZ entity → 422 ──
  await prisma.entity.update({ where: { id: ENT2 }, data: { countryCode: 'NZ' } });
  const nz = await call(ctrl.catalog, { user: USER2, query: { entityId: ENT2 } });
  ok(nz.statusCode === 422, `NZ entity catalog → 422 India-only (got ${nz.statusCode})`);

  await teardown();
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => { console.error('FATAL', e && e.stack ? e.stack : e); try { await teardown(); await prisma.$disconnect(); } catch (_) {} process.exit(1); });
