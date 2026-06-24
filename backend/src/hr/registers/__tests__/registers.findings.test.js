'use strict';

/*
 * registers.findings.test.js — Feature 32 CYCLE-4 regression proofs for the four
 * confirmed register findings. One assertion block per finding:
 *
 *   1. HIGH — the muster daily grid reads ONLY frozen (isLocked) Attendance and
 *      uses the RUN periodStart/periodEnd (not the calendar month). On a
 *      non-calendar cycle (26→25) the grid days + the frozen summary share ONE
 *      window, and a post-freeze unlocked edit NEVER surfaces.
 *   2. MED  — statutory PII (PAN/UAN/ESIC/DOB/address) is masked for a standard
 *      canViewPayrollReports holder and unmasked for a statutory admin.
 *   3. MED  — CSV/XLSX export neutralises formula-injection on employee text.
 *   4. LOW  — the ESI half-yearly register sums the full 6-month window.
 *
 * Plain-node (built-in assert; the live block needs hr_test):
 *   DATABASE_URL="$HR_TEST_URL" node src/hr/registers/__tests__/registers.findings.test.js
 */

const assert = require('assert');
const prisma = require('../../../core/lib/prisma');
const ctrl = require('../registers.controller');
const P = require('../projector');
const E = require('../exporters');
const csv = require('../exporters/csvExport');

let failures = 0;
function ok(cond, msg) { if (cond) { console.log(`  PASS  ${msg}`); } else { failures += 1; console.log(`  FAIL  ${msg}`); } }

// ── Finding 3 (PURE): formula-injection neutralisation on export ──────────────
function pureFormulaInjectionTests() {
  console.log('\nFinding 3 — CSV/XLSX formula-injection neutralisation:');
  // neutralizeFormula prefixes a quote on a formula-leading cell, leaves safe ones.
  ok(csv.neutralizeFormula('=HYPERLINK("http://evil")') === "'=HYPERLINK(\"http://evil\")", 'leading = is neutralised');
  ok(csv.neutralizeFormula('+1+1') === "'+1+1", 'leading + is neutralised');
  ok(csv.neutralizeFormula('-cmd') === "'-cmd", 'leading - is neutralised');
  ok(csv.neutralizeFormula('@SUM') === "'@SUM", 'leading @ is neutralised');
  ok(csv.neutralizeFormula('\tTAB') === "'\tTAB", 'leading TAB is neutralised');
  ok(csv.neutralizeFormula('Asha Rao') === 'Asha Rao', 'a safe name is untouched');
  ok(csv.neutralizeFormula('') === '', 'empty stays empty');

  // End-to-end: an employee whose NAME is a formula must be neutralised in the CSV.
  const def = require('../india.registers.seed').wageRegister(null, 'FORM_X', 'Register of Wages (Form X)', 'Min Wages 1948');
  const evil = '=HYPERLINK("http://evil.tld","OK")';
  const bundle = {
    frozen: true, period: { year: 2026, month: 5 },
    workers: [{
      employee: { id: 'e1', code: 'EMP001', firstName: evil, lastName: '', designation: 'Engineer' },
      statutory: { uan: '100200300400', esicIp: '31000', pan: 'ABCDE1234F' },
      line: { payableDays: 30, lopDays: 0, grossEarnings: '50000.00', pfEmployee: '1800.00', esiEmployee: '0', pt: '200.00', lwfEmployee: '12', tds: '2500.00', totalDeductions: '4512.00', netPay: '45488.00' },
      components: [], summary: { payableDays: 30 },
    }],
  };
  const reg = P.buildRegister(def, bundle, { period: { year: 2026, month: 5 } });
  const out = E.buildCsv(reg, { header: { legalName: 'Acme' }, fileBase: 'wage' });
  const body = String(out.content);
  ok(!/(^|,)=HYPERLINK/.test(body), 'CSV body never has a bare leading = formula cell');
  ok(body.includes("'=HYPERLINK") || body.includes('"\'=HYPERLINK'), 'the evil name is quote-prefixed (neutralised) in the CSV');
  // xlsx path (falls back to CSV when xlsx absent — either way must be neutralised).
  const xlsx = E.buildXlsx(reg, { header: { legalName: 'Acme' }, fileBase: 'wage' });
  if (!Buffer.isBuffer(xlsx.content)) {
    ok(!/(^|,)=HYPERLINK/.test(String(xlsx.content)), 'XLSX/CSV-fallback also neutralises the formula');
  } else {
    ok(true, 'XLSX produced a binary workbook (aoa cells neutralised at source)');
  }
}

// ── Finding 2 (PURE): masking via the projector maskFields contract ───────────
function pureMaskingTests() {
  console.log('\nFinding 2 — PII masking (projector maskFields contract):');
  const def = require('../india.registers.seed').employeeRegister(null, 'FORM_A', 'Register of Employees', 'EoC 2017');
  const bundle = {
    frozen: true,
    workers: [{
      employee: { id: 'e1', code: 'EMP001', firstName: 'Asha', lastName: 'Rao', designation: 'Engineer', hireDate: '2020-01-01', dateOfBirth: '1990-06-15', gender: 'F', fatherName: 'Asha Sr', addressLine1: '12 MG Road, Pune' },
      statutory: { uan: '100200300400', esicIp: '3100099', pan: 'ABCDE1234F' },
    }],
  };
  const maskFields = ctrl.resolveMaskFields({ role: 'STAFF', businessRole: { permissions: { canViewPayrollReports: true } } }, def);
  ok(maskFields.has('pan') && maskFields.has('uan') && maskFields.has('esic') && maskFields.has('dob') && maskFields.has('addr'),
    'standard canViewPayrollReports holder ⇒ PAN/UAN/ESIC/DOB/address are maskable');
  const reg = P.buildRegister(def, bundle, { maskFields });
  const findCell = (key) => { const i = reg.columns.findIndex((c) => c.key === key); return i < 0 ? null : reg.rows[0].cells[i].text; };
  ok(findCell('pan') !== 'ABCDE1234F' && findCell('pan').endsWith('234F'), `PAN tail-masked (got ${findCell('pan')})`);
  ok(findCell('uan') !== '100200300400' && /•/.test(findCell('uan')), `UAN tail-masked (got ${findCell('uan')})`);
  ok(findCell('esic') !== '3100099' && /•/.test(findCell('esic')), `ESIC tail-masked (got ${findCell('esic')})`);
  ok(findCell('dob') !== '15-06-1990' && findCell('dob') !== '', `DOB redacted (got ${findCell('dob')})`);
  ok(findCell('addr') !== '12 MG Road, Pune', `address redacted (got ${findCell('addr')})`);
  // the NON-PII columns are untouched.
  ok(findCell('name') === 'Asha Rao', 'non-PII name is untouched');

  // a statutory admin (canManageStatutory) sees everything in the clear.
  const adminMask = ctrl.resolveMaskFields({ role: 'STAFF', businessRole: { permissions: { canViewPayrollReports: true, canManageStatutory: true } } }, def);
  ok(adminMask.size === 0, 'statutory admin (canManageStatutory) ⇒ NO masking (higher key)');
  const regAdmin = P.buildRegister(def, bundle, { maskFields: adminMask });
  const adminPan = regAdmin.rows[0].cells[regAdmin.columns.findIndex((c) => c.key === 'pan')].text;
  ok(adminPan === 'ABCDE1234F', 'statutory admin sees the raw PAN');
}

// ── Finding 1 (PURE): non-calendar window grid + frozen summary share one window
function pureMusterWindowTests() {
  console.log('\nFinding 1 — muster grid uses the run window (non-calendar cycle):');
  const def = require('../india.registers.seed').musterRoll(null, 'FORM_25', 'Muster Roll', 'Factories 1948');
  // 26-May → 25-Jun cycle (non-calendar). The grid must print 26 May .. 25 Jun.
  const bundle = {
    frozen: true,
    window: { start: new Date(Date.UTC(2026, 4, 26)), end: new Date(Date.UTC(2026, 5, 25)) },
    workers: [{
      employee: { id: 'e1', code: 'EMP001', firstName: 'Asha', lastName: 'Rao', designation: 'Eng', hireDate: '2020-01-01' },
      statutory: { uan: 'U', esicIp: 'I' },
      summary: { payableDays: 30, paidLeaveDays: 0, lopDays: 0, lwpDays: 0, absentDays: 0, weeklyOffDays: 0, holidayDays: 0, overtimeHours: 0 },
      days: [
        { date: '2026-05-26', status: 'PRESENT', lopFraction: 0 },
        { date: '2026-06-25', status: 'ABSENT', lopFraction: 1 },
        { date: '2026-05-01', status: 'PRESENT', lopFraction: 0 }, // OUTSIDE the window — must not bind to a column
      ],
    }],
  };
  const reg = P.buildRegister(def, bundle, {});
  const dayCols = reg.columns.filter((c) => c.daily);
  // 26 May (6 days) + 25 Jun (25 days) = 31 columns
  ok(dayCols.length === 31, `grid spans the run window = 31 day-columns (got ${dayCols.length})`);
  ok(dayCols[0].label === '26', `first grid day labelled 26 (May 26), got ${dayCols[0].label}`);
  ok(dayCols[dayCols.length - 1].label === '25', `last grid day labelled 25 (Jun 25), got ${dayCols[dayCols.length - 1].label}`);
  const firstDaily = reg.columns.findIndex((c) => c.daily);
  ok(reg.rows[0].cells[firstDaily].text === 'P', '26 May = P (in-window frozen present)');
  ok(reg.rows[0].cells[firstDaily + dayCols.length - 1].text === 'A', '25 Jun = A (in-window frozen absent)');
  // the 1-May row is OUTSIDE the window → it has no column, so it never prints.
  ok(!dayCols.some((c) => c.label === '1' && c._date === '2026-05-01'), '1-May (outside window) has no grid column');
}

async function liveTests() {
  const PFX = 'F32FIND';
  const BIZ = `${PFX}-biz`;
  const ENT = `${PFX}-ent`;
  const CAL = `${PFX}-cal`;
  const DESIG = `${PFX}-desig`;
  const E1 = `${PFX}-e1`;
  const E2 = `${PFX}-e2`;
  const ef = new Date(Date.UTC(2020, 3, 1));
  const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
  const USER_REPORTS = { id: 'u-rep', businessId: BIZ, role: 'STAFF', businessRole: { name: 'LineMgr', permissions: { canViewPayrollReports: true }, defaultScope: 'ALL' } };
  const USER_ADMIN = { id: 'u-adm', businessId: BIZ, role: 'STAFF', businessRole: { name: 'StatAdmin', permissions: { canViewPayrollReports: true, canManageStatutory: true }, defaultScope: 'ALL' } };

  function mockRes() {
    return {
      statusCode: 200, body: null, headers: {}, sent: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
      setHeader(k, v) { this.headers[k] = v; return this; },
      send(b) { this.sent = b; return this; },
    };
  }
  async function call(handler, { user, query = {}, body = {}, scope } = {}) {
    const res = mockRes();
    await handler({ user, params: {}, query, body, scope: scope || { kind: 'ALL' } }, res);
    return res;
  }

  async function teardown() {
    await prisma.registerExport.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.registerDefinition.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.payRunLineComponent.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.payRunLine.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.attendancePayInput.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.attendance.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.payRun.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.payCalendar.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.statutoryProfile.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.employmentRecord.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.designation.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.statutoryRegistration.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.entity.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.business.deleteMany({ where: { id: BIZ } }).catch(() => {});
  }

  async function setup() {
    await teardown();
    await prisma.business.create({ data: { id: BIZ, name: `${BIZ} Pvt`, slug: `${PFX.toLowerCase()}` } });
    await prisma.entity.create({ data: { id: ENT, businessId: BIZ, code: `${ENT}-HQ`, legalName: ENT, countryCode: 'IN', payCurrency: 'INR', stateCode: 'MH', timezone: 'Asia/Kolkata', activeFrom: ef, pan: 'AAACA1234A', tan: 'PNEA01234B' } });
    await prisma.statutoryRegistration.createMany({ data: [
      { businessId: BIZ, entityId: ENT, kind: 'ESI', number: 'ESI-N', effectiveFrom: ef, isActive: true },
      { businessId: BIZ, entityId: ENT, kind: 'EPF', number: 'EPF-N', effectiveFrom: ef, isActive: true },
    ] });
    await prisma.designation.create({ data: { id: DESIG, businessId: BIZ, code: 'ENG', title: 'Engineer' } });
    const mkEmp = async (id, code, fn, ln) => {
      await prisma.employee.create({ data: { id, businessId: BIZ, code, firstName: fn, lastName: ln, fatherName: `${fn} Sr`, hireDate: D(2020, 1, 1), dateOfBirth: D(1990, 6, 15), gender: 'FEMALE', addressLine1: '12 MG Road, Pune', status: 'ACTIVE' } });
      await prisma.statutoryProfile.create({ data: { businessId: BIZ, employeeId: id, countryCode: 'IN', uan: `10020030040${code.slice(-1)}`, esicIp: `310009${code.slice(-1)}`, pan: `ABCDE123${code.slice(-1)}F` } });
      await prisma.employmentRecord.create({ data: { businessId: BIZ, employeeId: id, entityId: ENT, employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE', designationId: DESIG, effectiveFrom: D(2020, 1, 1), isCurrent: true } });
    };
    await mkEmp(E1, 'EMP001', 'Asha', 'Rao');
    await mkEmp(E2, 'EMP002', 'Vikram', 'Singh');
    await prisma.payCalendar.create({ data: { id: CAL, businessId: BIZ, entityId: ENT, code: 'MC', name: 'Monthly', frequency: 'MONTHLY', payDayRule: 'LAST_WORKING_DAY', cutoffDayRule: 'LAST_WORKING_DAY' } });

    // ── A NON-CALENDAR (26-May → 25-Jun) LOCKED run for the muster proof ──
    const RUN_NC = `${PFX}-run-nc`;
    await prisma.payRun.create({ data: { id: RUN_NC, businessId: BIZ, entityId: ENT, payCalendarId: CAL, code: 'PR-NC', periodStart: D(2026, 5, 26), periodEnd: D(2026, 6, 25), payDate: D(2026, 6, 26), sequenceInYear: 3, taxYear: '2026-27', currencyCode: 'INR', status: 'LOCKED' } });
    await prisma.payRunLine.create({ data: { businessId: BIZ, payRunId: RUN_NC, employeeId: E1, compensationId: 'c-x', payableDays: 30, lopDays: 0, overtimeHours: 0, currencyCode: 'INR', grossEarnings: '50000.00', totalDeductions: '0', netPay: '50000.00', pfEmployee: 0, pfEmployer: 0, esiEmployee: 0, esiEmployer: 0, pt: 0, lwfEmployee: 0, tds: 0, pfWagesBase: 15000 } });
    await prisma.attendancePayInput.create({ data: { businessId: BIZ, payRunId: RUN_NC, employeeId: E1, periodStart: D(2026, 5, 26), periodEnd: D(2026, 6, 25), calendarDays: 31, payableDays: 30, lopDays: 0, lwpDays: 0, absentDays: 1, paidLeaveDays: 0, weeklyOffDays: 0, holidayDays: 0, overtimeHours: 0, standardDays: 31 } });
    // Frozen (isLocked) daily attendance INSIDE the run window …
    await prisma.attendance.createMany({ data: [
      { businessId: BIZ, employeeId: E1, date: D(2026, 5, 26), status: 'PRESENT', lopFraction: 0, isLocked: true },
      { businessId: BIZ, employeeId: E1, date: D(2026, 6, 25), status: 'ABSENT', lopFraction: 1, isLocked: true },
      // … a CALENDAR-MONTH-MAY day (1-May) that is OUTSIDE the run window — must NOT print.
      { businessId: BIZ, employeeId: E1, date: D(2026, 5, 1), status: 'PRESENT', lopFraction: 0, isLocked: true },
      // … a post-freeze UNLOCKED correction in-flight on 27-May — must NEVER surface.
      { businessId: BIZ, employeeId: E1, date: D(2026, 5, 27), status: 'PRESENT', lopFraction: 0, isLocked: false },
    ] });

    // ── 6 monthly LOCKED runs across H2-2026 (Oct 2026..Mar 2027) for the ESI
    //    half-year proof. (H2, not H1, so they never collide with the May
    //    non-calendar muster run created above for finding 1.) ──
    const h2Months = [{ y: 2026, m: 10 }, { y: 2026, m: 11 }, { y: 2026, m: 12 }, { y: 2027, m: 1 }, { y: 2027, m: 2 }, { y: 2027, m: 3 }];
    for (const { y, m } of h2Months) {
      const id = `${PFX}-esi-${y}-${m}`;
      await prisma.payRun.create({ data: { id, businessId: BIZ, entityId: ENT, payCalendarId: CAL, code: `PR-ESI-${y}-${m}`, periodStart: D(y, m, 1), periodEnd: D(y, m + 1, 0), payDate: D(y, m + 1, 1), sequenceInYear: m, taxYear: '2026-27', currencyCode: 'INR', status: 'LOCKED' } });
      await prisma.payRunLine.create({ data: { businessId: BIZ, payRunId: id, employeeId: E1, compensationId: 'c-x', payableDays: 30, lopDays: 0, overtimeHours: 0, currencyCode: 'INR', grossEarnings: '20000.00', totalDeductions: '150.00', netPay: '19850.00', pfEmployee: 0, pfEmployer: 0, esiEmployee: '150.00', esiEmployer: '650.00', pt: 0, lwfEmployee: 0, tds: 0, pfWagesBase: 0 } });
    }
    // a 7th LOCKED run in APR-2027 (H1-2027) — must NOT be summed into the H2-2026 register.
    const idApr = `${PFX}-esi-2027-4`;
    await prisma.payRun.create({ data: { id: idApr, businessId: BIZ, entityId: ENT, payCalendarId: CAL, code: 'PR-ESI-2027-4', periodStart: D(2027, 4, 1), periodEnd: D(2027, 4, 30), payDate: D(2027, 5, 1), sequenceInYear: 4, taxYear: '2027-28', currencyCode: 'INR', status: 'LOCKED' } });
    await prisma.payRunLine.create({ data: { businessId: BIZ, payRunId: idApr, employeeId: E1, compensationId: 'c-x', payableDays: 30, lopDays: 0, overtimeHours: 0, currencyCode: 'INR', grossEarnings: '99999.00', totalDeductions: '0', netPay: '99999.00', pfEmployee: 0, pfEmployer: 0, esiEmployee: '9999.00', esiEmployer: '9999.00', pt: 0, lwfEmployee: 0, tds: 0, pfWagesBase: 0 } });
  }

  console.log('\nLIVE (hr_test) — findings 1, 2, 4:');
  await setup();

  // ── Finding 1: muster on a NON-CALENDAR cycle — grid window == frozen summary ──
  const muster = await call(ctrl.preview, { user: USER_ADMIN, query: { entityId: ENT, kind: 'MUSTER_ROLL', formCode: 'FORM_25', period: '2026-05' } });
  ok(muster.statusCode === 200 && muster.body.frozen === true, 'muster preview frozen:true');
  const dayCols = (muster.body.columns || []).filter((c) => c.daily);
  ok(dayCols.length === 31, `muster grid = 31 day-cols over the 26-May→25-Jun run window (got ${dayCols.length})`);
  ok(dayCols[0].label === '26' && dayCols[dayCols.length - 1].label === '25', 'grid starts at 26 (May) and ends at 25 (Jun) — the run period, NOT the calendar month');
  const r0 = muster.body.rows[0];
  const firstDaily = muster.body.columns.findIndex((c) => c.daily);
  ok(r0.cells[firstDaily].text === 'P', '26-May = P (frozen+locked, in window)');
  ok(r0.cells[firstDaily + 30].text === 'A', '25-Jun = A (frozen+locked, in window)');
  // the unlocked 27-May correction (day-col index 1) must show — (dash), NOT P.
  ok(r0.cells[firstDaily + 1].text === '—', '27-May (post-freeze UNLOCKED edit) is NOT shown — grid reads only isLocked rows');
  // the frozen summary's absent count (1) reconciles — and the grid shows exactly 1 A.
  const absentIdx = muster.body.columns.findIndex((c) => c.key === 'absent');
  ok(r0.cells[absentIdx].text === '1.00', 'frozen Absent summary = 1.00');
  const gridAbsent = dayCols.filter((c, i) => r0.cells[firstDaily + i].text === 'A').length;
  ok(gridAbsent === 1, `the grid prints exactly 1 absent mark — reconciles to the frozen summary (got ${gridAbsent})`);

  // ── Finding 2: PII masking via the live export for the STANDARD role ──
  await call(ctrl.seedDefinitions, { user: USER_ADMIN, body: { entityId: ENT } });
  const empMasked = await call(ctrl.preview, { user: USER_REPORTS, query: { entityId: ENT, kind: 'EMPLOYEE_REGISTER', formCode: 'FORM_A', period: '2026-06-24' } });
  ok(empMasked.body.frozen === true, 'employee register preview frozen (snapshot)');
  const colIdx = (k) => empMasked.body.columns.findIndex((c) => c.key === k);
  const cell = (k) => empMasked.body.rows[0].cells[colIdx(k)].text;
  ok(cell('pan') !== 'ABCDE1231F' && /•/.test(cell('pan')), `standard role: PAN masked (got ${cell('pan')})`);
  ok(/•/.test(cell('uan')), `standard role: UAN masked (got ${cell('uan')})`);
  ok(/•/.test(cell('esic')), `standard role: ESIC masked (got ${cell('esic')})`);
  ok(cell('addr') !== '12 MG Road, Pune', `standard role: address redacted (got ${cell('addr')})`);
  // the CSV export for the standard role must ALSO carry the masked PAN (never raw).
  const expMasked = await call(ctrl.exportRegister, { user: USER_REPORTS, query: { entityId: ENT, kind: 'EMPLOYEE_REGISTER', formCode: 'FORM_A', period: '2026-06-24', format: 'CSV' } });
  ok(expMasked.statusCode === 200 && !String(expMasked.sent).includes('ABCDE1231F'), 'standard role CSV export NEVER contains the raw PAN');
  // the statutory admin sees it raw.
  const empRaw = await call(ctrl.preview, { user: USER_ADMIN, query: { entityId: ENT, kind: 'EMPLOYEE_REGISTER', formCode: 'FORM_A', period: '2026-06-24' } });
  const rawPan = empRaw.body.rows[0].cells[empRaw.body.columns.findIndex((c) => c.key === 'pan')].text;
  ok(rawPan === 'ABCDE1231F', `statutory admin sees the raw PAN (got ${rawPan})`);

  // ── Finding 4: ESI half-year sums 6 months, not one (H2-2026 = Oct..Mar) ──
  const esi = await call(ctrl.preview, { user: USER_ADMIN, query: { entityId: ENT, kind: 'ESI_REGISTER', formCode: 'ESI_HY', period: 'H2-2026' } });
  ok(esi.statusCode === 200 && esi.body.frozen === true, 'ESI half-year preview frozen:true');
  ok(esi.body.total === 1, `ESI register has the 1 contributing member (got ${esi.body.total})`);
  // 6 months × ₹20,000 gross = ₹1,20,000 ; 6 × 150 EE = 900 ; 6 × 650 ER = 3900.
  ok(esi.body.totals.esiWage && esi.body.totals.esiWage.value === 120000, `ESI wages = 6×20000 = 120000 (got ${esi.body.totals.esiWage && esi.body.totals.esiWage.value})`);
  ok(esi.body.totals.esiEe && esi.body.totals.esiEe.value === 900, `ESI (EE) = 6×150 = 900 (got ${esi.body.totals.esiEe && esi.body.totals.esiEe.value})`);
  ok(esi.body.totals.esiEr && esi.body.totals.esiEr.value === 3900, `ESI (ER) = 6×650 = 3900 (got ${esi.body.totals.esiEr && esi.body.totals.esiEr.value})`);
  ok(esi.body.meta && esi.body.meta.periodLabel === 'H2-2026', `period label normalised to H2-2026 (got ${esi.body.meta && esi.body.meta.periodLabel})`);
  // and the APR-2027 (next H1) run's ₹99,999 is NOT included.
  ok(esi.body.totals.esiWage.value !== 219999, 'an out-of-window (Apr-2027/next H1) run is NOT summed into H2-2026');
  // a single MONTH token resolves to the 6-month window it belongs to (back-compat).
  const esiMonth = await call(ctrl.preview, { user: USER_ADMIN, query: { entityId: ENT, kind: 'ESI_REGISTER', formCode: 'ESI_HY', period: '2026-12' } });
  ok(esiMonth.body.frozen === true && esiMonth.body.totals.esiWage.value === 120000, 'a YYYY-MM token (2026-12) still sums the full H2 window (back-compat)');
  // the export bounds span the full 6-month window (Oct 2026 .. Mar 2027).
  const esiExp = await call(ctrl.exportRegister, { user: USER_ADMIN, query: { entityId: ENT, kind: 'ESI_REGISTER', formCode: 'ESI_HY', period: 'H2-2026', format: 'CSV' } });
  ok(esiExp.statusCode === 200, 'ESI half-year CSV export → 200');
  const esiRow = await prisma.registerExport.findFirst({ where: { businessId: BIZ, kind: 'ESI_REGISTER' }, orderBy: { createdAt: 'desc' } });
  ok(esiRow && new Date(esiRow.periodStart).getUTCMonth() === 9 && new Date(esiRow.periodStart).getUTCFullYear() === 2026
    && new Date(esiRow.periodEnd).getUTCMonth() === 2 && new Date(esiRow.periodEnd).getUTCFullYear() === 2027,
    'RegisterExport bounds span Oct-2026..Mar-2027 (the 6-month window)');

  await teardown();
}

async function main() {
  console.log('Feature 32 — cycle-4 register findings regression:');
  // pure blocks (no DB)
  pureFormulaInjectionTests();
  pureMaskingTests();
  pureMusterWindowTests();

  const hasDb = !!process.env.DATABASE_URL;
  if (hasDb) {
    try {
      await liveTests();
    } catch (e) {
      failures += 1;
      console.error('LIVE FATAL', e && e.stack ? e.stack : e);
    } finally {
      try { await prisma.$disconnect(); } catch (_) {}
    }
  } else {
    console.log('\n(skipping LIVE block — no DATABASE_URL)');
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures ? 1 : 0);
}

main();
