'use strict';

/*
 * registers.golden.test.js — Feature 32 golden tests for the PURE register
 * projector (../projector.js) + the default IN definition set
 * (../india.registers.seed.js) + the three exporters (../exporters).
 *
 * Plain-node (built-in assert, NO jest):
 *   node src/hr/registers/__tests__/registers.golden.test.js
 *
 * Covers: the status-mark vocabulary, the daily-grid expansion (28/29/30/31-day
 * months incl. leap-Feb), the rupee/days transforms, control totals (the wage
 * register reconciles to the frozen PayRunLine to the paise), the not-frozen
 * gate, per-state form selection off ONE bundle, applicability seeding, and that
 * every exporter produces a valid artefact (PDF magic header, CSV/XLSX bytes).
 */

const assert = require('assert');
const P = require('../projector');
const S = require('../india.registers.seed');
const E = require('../exporters');

let passed = 0;
let failed = 0;
const fails = [];
function eq(label, expected, actual) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); console.log(`  FAIL  ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
function ok(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}`); }
}

console.log('Feature 32 — statutory registers golden:\n');

// ── 1. status-mark vocabulary (must match what payroll froze) ─────────────────
eq('statusMark PRESENT', 'P', P.statusMark('PRESENT', 0));
eq('statusMark WFH', 'P', P.statusMark('WORK_FROM_HOME', 0));
eq('statusMark HALF_DAY', '½', P.statusMark('HALF_DAY', 0.5));
eq('statusMark ON_LEAVE paid', 'L', P.statusMark('ON_LEAVE', 0));
eq('statusMark ON_LEAVE lwp', 'LWP', P.statusMark('ON_LEAVE', 0.5));
eq('statusMark ABSENT', 'A', P.statusMark('ABSENT', 1));
eq('statusMark WEEKLY_OFF', 'WO', P.statusMark('WEEKLY_OFF', 0));
eq('statusMark HOLIDAY', 'H', P.statusMark('HOLIDAY', 0));
eq('statusMark HOLIDAY_WORKED', 'H*', P.statusMark('HOLIDAY_WORKED', 0));
eq('statusMark MISSING_PUNCH', 'MP', P.statusMark('MISSING_PUNCH', 0));

// ── 2. daily-grid expansion across month lengths (leap-Feb golden) ────────────
eq('Feb 2024 (leap) = 29 cols', 29, P.expandDailyColumns({ year: 2024, month: 2 }).length);
eq('Feb 2025 (non-leap) = 28 cols', 28, P.expandDailyColumns({ year: 2025, month: 2 }).length);
eq('Apr 2026 = 30 cols', 30, P.expandDailyColumns({ year: 2026, month: 4 }).length);
eq('May 2026 = 31 cols', 31, P.expandDailyColumns({ year: 2026, month: 5 }).length);

// ── 3. transforms ─────────────────────────────────────────────────────────────
eq('rupee en-IN grouping', '₹1,23,456.50', P.formatRupee(123456.5));
eq('rupee negative', '-₹1,000.00', P.formatRupee(-1000));

// ── 4. WAGE register projection + control totals reconcile to the paise ───────
const wageDef = S.wageRegister(null, 'FORM_X', 'Register of Wages (Form X)', 'Minimum Wages Act 1948');
const wageBundle = {
  frozen: true,
  payRun: { id: 'pr1', code: 'PR-2026-05', status: 'LOCKED', currencyCode: 'INR' },
  period: { year: 2026, month: 5 },
  workers: [
    {
      employee: { id: 'e1', code: 'EMP001', firstName: 'Asha', lastName: 'Rao', designation: 'Engineer' },
      statutory: { uan: '100200300400', esicIp: '31000', pan: 'ABCDE1234F' },
      line: { payableDays: 30, lopDays: 0, grossEarnings: '50000.00', pfEmployee: '1800.00', esiEmployee: '0.00', pt: '200.00', lwfEmployee: '12.00', tds: '2500.00', totalDeductions: '4512.00', netPay: '45488.00' },
      components: [], summary: { payableDays: 30 },
    },
    {
      employee: { id: 'e2', code: 'EMP002', firstName: 'Vikram', lastName: 'Singh', designation: 'Manager' },
      statutory: { uan: '100200300401', esicIp: '31001', pan: 'ABCDE1234G' },
      line: { payableDays: 28, lopDays: 2, grossEarnings: '75000.00', pfEmployee: '1800.00', esiEmployee: '0.00', pt: '200.00', lwfEmployee: '12.00', tds: '6000.00', totalDeductions: '8012.00', netPay: '66988.00' },
      components: [], summary: { payableDays: 28 },
    },
  ],
};
const wageReg = P.buildRegister(wageDef, wageBundle, { period: { year: 2026, month: 5 } });
eq('wage register frozen', true, wageReg.frozen);
eq('wage register rowCount', 2, wageReg.rowCount);
// gross = 50000 + 75000 = 125000 ; net = 45488 + 66988 = 112476 ; pf = 3600 ; tds = 8500
eq('wage GROSS total reconciles', '₹1,25,000.00', wageReg.totals.byColumn.gross.display);
eq('wage NET total reconciles', '₹1,12,476.00', wageReg.totals.byColumn.net.display);
eq('wage PF(EE) total reconciles', '₹3,600.00', wageReg.totals.byColumn.pfEe.display);
eq('wage TDS total reconciles', '₹8,500.00', wageReg.totals.byColumn.tds.display);
eq('wage NET total (numeric value)', 112476, wageReg.totals.byColumn.net.value);
// first row cells: Sl=1, code, name "Asha Rao"
ok('wage row1 Sl=1', wageReg.rows[0].cells[0].text === '1');
ok('wage row1 name=Asha Rao', wageReg.rows[0].cells.some((c) => c.text === 'Asha Rao'));
ok('wage row1 UAN present', wageReg.rows[0].cells.some((c) => c.text === '100200300400'));

// ── 5. MUSTER roll reflects the frozen daily attendance (present/absent/leave) ─
const musterDef = S.musterRoll(null, 'FORM_25', 'Muster Roll (Form 25)', 'Factories Act 1948');
const musterBundle = {
  frozen: true,
  period: { year: 2026, month: 4 }, // 30-day month
  workers: [
    {
      employee: { id: 'e1', code: 'EMP001', firstName: 'Asha', lastName: 'Rao', designation: 'Engineer', hireDate: '2020-01-01' },
      statutory: { uan: '100200300400', esicIp: '31000' },
      summary: { payableDays: 26, paidLeaveDays: 2, lopDays: 1, lwpDays: 1, absentDays: 0, weeklyOffDays: 4, holidayDays: 1, overtimeHours: 5 },
      days: [
        { date: '2026-04-01', status: 'PRESENT', lopFraction: 0 },
        { date: '2026-04-02', status: 'ABSENT', lopFraction: 1 },
        { date: '2026-04-03', status: 'ON_LEAVE', lopFraction: 0 },
        { date: '2026-04-04', status: 'WEEKLY_OFF', lopFraction: 0 },
        { date: '2026-04-05', status: 'HOLIDAY', lopFraction: 0 },
        { date: '2026-04-06', status: 'ON_LEAVE', lopFraction: 1 }, // LWP
        { date: '2026-04-07', status: 'HALF_DAY', lopFraction: 0.5 },
      ],
    },
  ],
};
const musterReg = P.buildRegister(musterDef, musterBundle, { period: { year: 2026, month: 4 } });
eq('muster frozen', true, musterReg.frozen);
// header cols + 30 day cols + summary cols
const dayCols = musterReg.columns.filter((c) => c.daily);
eq('muster has 30 day columns', 30, dayCols.length);
// find the day-1..day-7 cells in row 0 (after the header columns)
const r0 = musterReg.rows[0].cells;
// locate the index of the first daily col in the column list
const firstDailyIdx = musterReg.columns.findIndex((c) => c.daily);
eq('muster day1 = P', 'P', r0[firstDailyIdx + 0].text);
eq('muster day2 = A', 'A', r0[firstDailyIdx + 1].text);
eq('muster day3 = L', 'L', r0[firstDailyIdx + 2].text);
eq('muster day4 = WO', 'WO', r0[firstDailyIdx + 3].text);
eq('muster day5 = H', 'H', r0[firstDailyIdx + 4].text);
eq('muster day6 = LWP', 'LWP', r0[firstDailyIdx + 5].text);
eq('muster day7 = half', '½', r0[firstDailyIdx + 6].text);
// day8 (no attendance row) = — (mid-period gap / pre-DOJ marker)
eq('muster day8 (no row) = dash', '—', r0[firstDailyIdx + 7].text);
// summary day counts match the FROZEN AttendancePayInput exactly
const lwpCell = r0[musterReg.columns.findIndex((c) => c.key === 'lwp')];
eq('muster LWP summary = frozen lwpDays', '1.00', lwpCell.text);
const absentCell = r0[musterReg.columns.findIndex((c) => c.key === 'absent')];
eq('muster Absent summary = frozen absentDays', '0.00', absentCell.text);

// ── 6. NOT_FROZEN gate — never a recomputed row ───────────────────────────────
const notFrozen = P.buildRegister(wageDef, { frozen: false, code: 'NOT_FROZEN', reason: 'The pay run for 2026-05 is DRAFT.' }, {});
eq('not-frozen returns frozen:false', false, notFrozen.frozen);
eq('not-frozen carries code', 'NOT_FROZEN', notFrozen.code);
ok('not-frozen carries a reason', typeof notFrozen.reason === 'string' && notFrozen.reason.length > 0);
ok('not-frozen has NO rows', !notFrozen.rows);

// ── 7. per-state form selection off ONE bundle (data, not a branch) ───────────
const combinedMH = S.musterWageCombined('MH', 'FORM_II', 'MH Form II', 'Maharashtra S&E 2017');
const mhReg = P.buildRegister(combinedMH, wageBundle, { period: { year: 2026, month: 5 } });
eq('MH Form II off same bundle frozen', true, mhReg.frozen);
eq('MH Form II net reconciles too', '₹1,12,476.00', mhReg.totals.byColumn.net.display);
eq('MH Form II formCode', 'FORM_II', mhReg.meta.formCode);
ok('MH Form II is MUSTER_WAGE_COMBINED', mhReg.meta.kind === 'MUSTER_WAGE_COMBINED');

// ── 8. applicability seeding ──────────────────────────────────────────────────
const defsAll = S.buildRegisterDefinitionsForRegistrations([{ kind: 'SHOPS_ESTABLISHMENT', stateCode: 'MH' }, { kind: 'EPF' }, { kind: 'ESI' }]);
ok('seed includes MH combined', defsAll.some((d) => d.kind === 'MUSTER_WAGE_COMBINED' && d.stateCode === 'MH'));
ok('EPF reg ⇒ PF_ANNUAL seeded', defsAll.some((d) => d.kind === 'PF_ANNUAL'));
ok('ESI reg ⇒ ESI_REGISTER seeded', defsAll.some((d) => d.kind === 'ESI_REGISTER'));
const defsNone = S.buildRegisterDefinitionsForRegistrations([]);
ok('no EPF ⇒ no PF_ANNUAL', !defsNone.some((d) => d.kind === 'PF_ANNUAL'));
ok('no ESI ⇒ no ESI_REGISTER', !defsNone.some((d) => d.kind === 'ESI_REGISTER'));
ok('every seeded column set validates', defsAll.every((d) => { try { P.assertColumns(d.columns); return true; } catch { return false; } }));

// ── 9. assertColumns rejects bad definitions at validate time ─────────────────
let threwUnknownTransform = false;
try { P.assertColumns([{ key: 'x', label: 'X', source: 'line', path: 'netPay', transform: 'NOPE' }]); }
catch (e) { threwUnknownTransform = e.code === 'BAD_COLUMN_TRANSFORM'; }
ok('assertColumns rejects unknown transform', threwUnknownTransform);
let threwUnknownSource = false;
try { P.assertColumns([{ key: 'x', label: 'X', source: 'galaxy', path: 'q' }]); }
catch (e) { threwUnknownSource = e.code === 'BAD_COLUMN_SOURCE'; }
ok('assertColumns rejects unknown source', threwUnknownSource);

// ── 10. exporters produce valid artefacts ─────────────────────────────────────
const header = { legalName: 'Acme Manufacturing Pvt Ltd', tradeName: 'Acme', city: 'Pune', stateCode: 'MH', pan: 'AAACA1234A', tan: 'PNEA01234B' };
wageReg.meta.periodLabel = '2026-05';
const csv = E.buildCsv(wageReg, { header, fileBase: 'wage' });
ok('CSV has content + name', csv.fileName === 'wage.csv' && Buffer.byteLength(csv.content) > 100);
ok('CSV contains the net total', csv.content.includes('1,12,476.00'));
ok('CSV contains the form label', csv.content.includes('Register of Wages'));
const xlsx = E.buildXlsx(wageReg, { header, fileBase: 'wage' });
ok('XLSX (or CSV fallback) returns bytes', xlsx.content && (Buffer.isBuffer(xlsx.content) ? xlsx.content.length > 0 : Buffer.byteLength(xlsx.content) > 0));

// async PDF — run last, then print the summary in the callback
E.buildPdf(wageReg, { header, fileBase: 'wage', fileHash: 'abc123' }).then((pdf) => {
  ok('PDF magic header %PDF-', pdf.content.slice(0, 5).toString() === '%PDF-');
  ok('PDF is non-trivial size', pdf.content.length > 1000);
  ok('PDF content-type', pdf.contentType === 'application/pdf');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.error('\nFAILURES:\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  console.log('All register golden tests passed.');
}).catch((e) => { console.error('PDF generation failed:', e.message); process.exit(1); });
