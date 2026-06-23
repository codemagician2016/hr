'use strict';

/*
 * filing.test.js — plain-node test (built-in assert, NO jest, NO node_modules):
 *   node backend/src/hr/payroll/filing/__tests__/filing.test.js
 *
 * Covers the PURE statutory generators in ../{india,newzealand}.js. Fixtures
 * carry per-employee amounts in INTEGER MINOR UNITS (paise / cents); expecteds
 * are hand-derived from docs/05-compliance-india.md §4.6/§5/§7.4 and
 * docs/06-compliance-newzealand.md §3.2 + docs/18 §3.3.
 */

const assert = require('assert');
const filing = require('../index');
const IN = require('../india');
const NZ = require('../newzealand');

const R = (rupees) => rupees * 100; // rupees -> paise
const D = (dollars) => dollars * 100; // dollars -> cents
let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok -', name);
  } catch (e) {
    console.error('  FAIL -', name, '\n   ', e.message);
    process.exitCode = 1;
  }
}

// ── India fixture: 2-member EPF establishment, May 2026 ─────────────────────
const inPayRun = {
  period: '2026-05',
  establishment: { pfEstablishmentCode: 'MHBAN0012345000', esicCode: '31000123450000999' },
  entity: { tan: 'BLRP01234E', name: 'Acme Tech Pvt Ltd' },
  quarter: 'Q1',
  financialYear: '2026-27',
  lines: [
    {
      employee: { uan: '100200300400', name: 'Asha Rao', esicIp: '3100123450', pan: 'ABCPR1234F', code: 'E001' },
      grossWagesMinor: R(30000), epfWagesMinor: R(15000), epsWagesMinor: R(15000), edliWagesMinor: R(15000),
      epfEeMinor: R(1800),   // 12% of 15000
      epsMinor: R(1250),     // 8.33% of 15000 = 1249.5 -> nearest rupee 1250
      epfErMinor: R(550),    // ER 3.67% of 15000 = 550.5 -> 550 (we pass exact 550 for clarity)
      ncpDays: 0, refundAdvanceMinor: 0,
      esiGrossMinor: 0, esiEeMinor: 0, esiErMinor: 0, esiCovered: false,
      tdsMinor: R(2500), taxableMinor: R(360000),
    },
    {
      employee: { uan: '100200300401', name: 'Vikram Singh', esicIp: '3100123451', pan: 'XYZPS9876Q', code: 'E002' },
      grossWagesMinor: R(18000), epfWagesMinor: R(18000), epsWagesMinor: R(15000), edliWagesMinor: R(15000),
      epfEeMinor: R(2160),   // 12% of 18000
      epsMinor: R(1250),
      epfErMinor: R(910),    // 2160 - 1250
      ncpDays: 2, refundAdvanceMinor: 0,
      // ESI covered: gross 18000 <= 21000
      esiGrossMinor: R(18000), esiEeMinor: R(135), esiErMinor: R(585), esiCovered: true,
      workedDays: 28, esiReasonCode: 0,
      tdsMinor: 0, taxableMinor: R(180000),
    },
  ],
};

ok('ECR: #~# delimited, 2 member lines, totals match', () => {
  const f = IN.generateEcr(inPayRun);
  const rows = f.content.trim().split('\r\n');
  assert.strictEqual(rows.length, 2, 'two member rows');
  assert.ok(f.content.includes('#~#'), 'uses #~# delimiter');
  // First row fields
  const c = rows[0].split('#~#');
  assert.strictEqual(c.length, 11, '11 ECR fields');
  assert.strictEqual(c[0], '100200300400', 'UAN');
  assert.strictEqual(c[1], 'Asha Rao', 'name');
  assert.strictEqual(c[2], '30000', 'gross wages rupees');
  assert.strictEqual(c[3], '15000', 'EPF wages');
  assert.strictEqual(c[4], '15000', 'EPS wages');
  assert.strictEqual(c[6], '1800', 'EPF remitted');
  assert.strictEqual(c[7], '1250', 'EPS remitted (1249.5 -> 1250)');
  assert.strictEqual(c[9], '0', 'NCP days');
  // Second row NCP = 2
  assert.strictEqual(rows[1].split('#~#')[9], '2', 'second member NCP days');
  // meta totals
  assert.strictEqual(f.meta.memberCount, 2);
  assert.strictEqual(f.meta.totals.epfWagesRupees, 33000); // 15000 + 18000
  assert.strictEqual(f.meta.totals.epfRemittedRupees, 3960); // 1800 + 2160
  assert.strictEqual(f.meta.totals.epsRemittedRupees, 2500); // 1250 + 1250
});

ok('ESIC: CSV header + only covered members + EE/ER totals', () => {
  const f = IN.generateEsic(inPayRun);
  const rows = f.content.trim().split('\r\n');
  assert.strictEqual(rows[0], IN._internals.ESIC_HEADER.join(','), 'header row');
  assert.ok(rows[0].startsWith('IPNumber,IPName,NoOfDays,TotalMonthlyWages'), 'ESIC columns');
  // Only Vikram is ESI-covered
  assert.strictEqual(rows.length, 2, 'header + 1 covered member');
  const c = rows[1].split(',');
  assert.strictEqual(c[0], '3100123451', 'IP number');
  assert.strictEqual(c[3], '18000', 'monthly wages rupees');
  assert.strictEqual(c[6], '135', 'EE contribution');
  assert.strictEqual(c[7], '585', 'ER contribution');
  assert.strictEqual(f.meta.coveredCount, 1);
  assert.strictEqual(f.meta.totals.esiEeRupees, 135);
  assert.strictEqual(f.meta.totals.esiErRupees, 585);
  assert.strictEqual(f.meta.totals.esiTotalRupees, 720);
});

ok('24Q: FVU records (FH/BH/CD/DD), rupee.2dp amounts, TDS total', () => {
  const f = IN.generate24Q(inPayRun);
  const rows = f.content.trim().split('\r\n');
  assert.strictEqual(rows[0].split('^')[0], 'FH', 'file header');
  assert.strictEqual(rows[1].split('^')[0], 'BH', 'batch header');
  const bh = rows[1].split('^');
  assert.strictEqual(bh[1], 'BLRP01234E', 'TAN in batch header');
  assert.strictEqual(bh[2], '24Q');
  assert.strictEqual(rows[2].split('^')[0], 'CD', 'challan detail');
  // two deductee detail rows
  const dd = rows.filter((r) => r.startsWith('DD^'));
  assert.strictEqual(dd.length, 2, 'two deductee rows');
  assert.strictEqual(dd[0].split('^')[2], 'ABCPR1234F', 'PAN');
  assert.strictEqual(dd[0].split('^')[6], '2500.00', 'TDS rupees.2dp');
  // total TDS = 2500 + 0 = 2500.00
  assert.strictEqual(f.meta.totals.tdsRupees, '2500.00');
  assert.strictEqual(f.meta.totals.tdsMinor, R(2500));
  assert.strictEqual(f.meta.annexureII, false, 'Q1 has no Annexure II');
});

// ── NZ fixture: 2-employee fortnightly pay run ──────────────────────────────
const nzPayRun = {
  periodStart: '2026-06-01', periodEnd: '2026-06-14', paydayDate: '2026-06-18',
  employer: { irdNumber: '123456789', name: 'Kiwi Widgets Ltd', shortName: 'KIWIWIDGE', payeRef: '123-456-789' },
  lines: [
    {
      employee: { name: 'Jane Doe', irdNumber: '049078009', taxCode: 'M', bankAccount: '12-3456-0078901-00' },
      grossMinor: D(2000), notLiableAccMinor: 0, payeMinor: D(380),
      ksEmployeeMinor: D(70),         // 3.5% of 2000
      ksEmployerGrossMinor: D(70),    // 3.5% match
      esctMinor: D(12.25),            // 17.5% tier of 70
      studentLoanMinor: D(60), studentLoanExtraMinor: 0,
      childSupportMinor: 0, donationsMinor: 0,
      netPayMinor: D(1490),
    },
    {
      employee: { name: 'Sam Te Rangi', irdNumber: '136410132', taxCode: 'M SL', bankAccount: '06-0001-0123456-00' },
      grossMinor: D(3000), notLiableAccMinor: D(0), payeMinor: D(650),
      ksEmployeeMinor: D(180),        // 6% elected
      ksEmployerGrossMinor: D(105),   // 3.5%
      esctMinor: D(31.50),
      studentLoanMinor: D(150), studentLoanExtraMinor: D(20),
      childSupportMinor: D(50), donationsMinor: 0,
      netPayMinor: D(1970),
    },
  ],
};

ok('EI: header + 2 employee lines, employer net KS = gross - ESCT, totals', () => {
  const f = NZ.generateEmploymentInformation(nzPayRun);
  const rows = f.content.trim().split('\r\n');
  assert.ok(rows[0].startsWith('# EI Return | IRD 123456789'), 'header comment');
  assert.strictEqual(rows[1], NZ._internals.EI_HEADER.join(','), 'column header');
  assert.ok(rows[1].includes('KiwiSaverEmployerNet') && rows[1].includes('ESCT'), 'has KS/ESCT cols');
  assert.strictEqual(rows.length, 4, 'comment + header + 2 employees');
  const c = rows[2].split(',');
  assert.strictEqual(c[0], '049078009', 'IRD number');
  assert.strictEqual(c[2], 'M', 'tax code');
  assert.strictEqual(c[5], '2000.00', 'gross dollars.2dp');
  assert.strictEqual(c[7], '380.00', 'PAYE');
  // employer net KS = 70.00 - 12.25 = 57.75
  const ksErNet = c[11];
  assert.strictEqual(ksErNet, '57.75', 'employer net KiwiSaver');
  // totals
  assert.strictEqual(f.meta.totals.grossDollars, '5000.00'); // 2000 + 3000
  assert.strictEqual(f.meta.totals.payeDollars, '1030.00');  // 380 + 650
  assert.strictEqual(f.meta.totals.ksEmployeeDollars, '250.00'); // 70 + 180
});

ok('Bank batch: detail rows + control with item count, total, hash', () => {
  const f = NZ.generateBankBatch(nzPayRun, { reference: 'KIWIWIDGE' });
  const rows = f.content.trim().split('\r\n');
  assert.strictEqual(rows.length, 3, '2 detail + 1 control');
  const d0 = rows[0].split(',');
  assert.strictEqual(d0[0], 'DC');
  assert.strictEqual(d0[1], '12-3456-0078901-00', 'account');
  assert.strictEqual(d0[3], '1490.00', 'net pay dollars');
  assert.strictEqual(d0[4], 'SALARY', 'default particulars');
  // control row
  const ctrl = rows[2].split(',');
  assert.strictEqual(ctrl[0], 'CTRL');
  assert.strictEqual(ctrl[1], '2', 'item count');
  assert.strictEqual(ctrl[2], '3460.00', 'total = 1490 + 1970');
  // hash = sum of all account digits across both accounts
  const h1 = NZ._internals.accountHash('12-3456-0078901-00');
  const h2 = NZ._internals.accountHash('06-0001-0123456-00');
  assert.strictEqual(ctrl[3], String(h1 + h2), 'hash total');
  assert.strictEqual(f.meta.control.totalMinor, D(3460));
});

ok('Bank batch: rejects invalid NZ account format', () => {
  const bad = { ...nzPayRun, lines: [{ employee: { name: 'X', bankAccount: '1234567' }, netPayMinor: D(10) }] };
  assert.throws(() => NZ.generateBankBatch(bad), /invalid NZ account/);
});

// finding #22 — the thrown error now carries a stable .code + .statusCode so the
// HTTP layer maps it to a 422 (MISSING_BANK_DETAILS), never a bare 500.
ok('Bank batch: invalid account error is coded 422 MISSING_BANK_DETAILS', () => {
  const bad = { ...nzPayRun, lines: [{ employee: { name: 'X', bankAccount: '' }, netPayMinor: D(10) }] };
  try {
    NZ.generateBankBatch(bad);
    assert.fail('expected throw');
  } catch (e) {
    assert.strictEqual(e.code, 'MISSING_BANK_DETAILS');
    assert.strictEqual(e.statusCode, 422);
  }
});

// finding #22 — pure pre-validation lists EVERY offender (missing/invalid/non-positive)
// without throwing, so the service can fail-closed with an actionable 422 payload.
ok('collectBankBatchIssues: reports missing, invalid, and non-positive lines', () => {
  const run = {
    lines: [
      { employee: { name: 'Good', code: 'E1', bankAccount: '12-3456-0078901-00' }, netPayMinor: D(100) },
      { employee: { name: 'NoAcct', code: 'E2', bankAccount: '' }, netPayMinor: D(50) },
      { employee: { name: 'BadAcct', code: 'E3', bankAccount: 'XYZ' }, netPayMinor: D(50) },
      { employee: { name: 'ZeroNet', code: 'E4', bankAccount: '06-0001-0123456-00' }, netPayMinor: 0 },
    ],
  };
  const issues = NZ.collectBankBatchIssues(run);
  const reasons = issues.map((i) => i.reason).sort();
  assert.deepStrictEqual(reasons, ['INVALID_BANK_ACCOUNT', 'MISSING_BANK_ACCOUNT', 'NON_POSITIVE_NET']);
  assert.ok(issues.every((i) => i.employee && i.detail), 'each offender carries name + detail');
});

ok('index re-exports all five generators', () => {
  for (const k of ['generateEcr', 'generateEsic', 'generate24Q', 'generateEmploymentInformation', 'generateBankBatch']) {
    assert.strictEqual(typeof filing[k], 'function', k);
  }
});

console.log(`\n${pass} assertions-blocks passed`);
if (process.exitCode) console.error('SOME TESTS FAILED');
else console.log('ALL FILING TESTS PASSED');
