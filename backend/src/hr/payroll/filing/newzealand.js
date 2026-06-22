'use strict';

/**
 * newzealand.js — PURE statutory file generators for NZ payroll filings.
 *
 * Generators are pure functions of a pay-run aggregate: no DB, no I/O, no Date.
 * Each returns { fileName, contentType, meta, content }.
 *
 * MONEY RULE: input line amounts are INTEGER MINOR UNITS (CENTS). We keep cents
 * integers for all running totals and only convert to dollars-with-2-decimals
 * at the formatted output (money.fromMinor). NEVER floats for the math.
 *
 * Pay-run aggregate shape (documented contract):
 *
 *   payRun = {
 *     periodStart: 'YYYY-MM-DD',
 *     periodEnd:   'YYYY-MM-DD',
 *     paydayDate:  'YYYY-MM-DD',     // drives the 2-working-day filing clock
 *     employer:    { irdNumber, name, shortName, payeRef },
 *     lines: [ {
 *       employee: { name, irdNumber, taxCode,
 *                   bankAccount: 'BB-bbbb-AAAAAAA-SSS' },
 *       // all CENTS (integer minor units):
 *       grossMinor,                 // gross earnings
 *       notLiableAccMinor,          // earnings not liable for ACC
 *       payeMinor,                  // income tax + ACC levy combined ("PAYE")
 *       esctMinor,
 *       ksEmployeeMinor,            // employee KiwiSaver deduction
 *       ksEmployerGrossMinor,       // employer KiwiSaver (gross, before ESCT)
 *       studentLoanMinor,           // standard SL
 *       studentLoanExtraMinor,      // SLCIR/SLBOR additional
 *       childSupportMinor, donationsMinor,
 *       netPayMinor,                // for the bank batch
 *       startDate, endDate,         // if new/departing in period
 *     } ]
 *   }
 *
 * Doc basis: docs/06-compliance-newzealand.md §3.2 (EI return field set),
 * §3 (payday filing), §2 (PAYE incl. ACC); docs/18-integrations.md §3.3 (NZ
 * direct-credit batch — IB4B / generic ABA 120-byte, particulars/code/reference,
 * hash totals + control record, BB-bbbb-AAAAAAA-SSS account structure).
 */

const { fromMinor } = require('../money');

const CENTS = 100;

function num(v) {
  if (v == null) return 0;
  if (!Number.isInteger(v)) throw new TypeError(`expected integer cents, got ${v}`);
  return v;
}

function dollars2(minor) {
  return fromMinor(num(minor), 2); // cents -> "1234.56"
}

function sumField(lines, field) {
  let t = 0;
  for (const l of lines) t += num(l[field]);
  return t;
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Employment Information (EI) — IRD payday-filing dataset
//    docs/06 §3.2. CSV for myIR upload (per docs/06 §3.1 / exporters.js note:
//    "EI return file generation CSV/JSON for myIR upload").
//
// Per-employee line columns (mapped to IRD's EI schema, §3.2 field table):
//   IRDNumber, Name, TaxCode, StartDate, EndDate,
//   Gross, EarningsNotLiableForACC, PAYE,
//   KiwiSaverEmployee, KiwiSaverEmployerGross, ESCT, KiwiSaverEmployerNet,
//   StudentLoan, StudentLoanExtra, ChildSupport, PayrollDonations
// (employer/period header carried separately in `meta` + a header comment row).
// ───────────────────────────────────────────────────────────────────────────

const EI_HEADER = [
  'IRDNumber',
  'Name',
  'TaxCode',
  'StartDate',
  'EndDate',
  'Gross',
  'EarningsNotLiableForACC',
  'PAYE',
  'KiwiSaverEmployee',
  'KiwiSaverEmployerGross',
  'ESCT',
  'KiwiSaverEmployerNet',
  'StudentLoan',
  'StudentLoanExtra',
  'ChildSupport',
  'PayrollDonations',
];

function generateEmploymentInformation(payRun) {
  assertPayRun(payRun);
  const lines = payRun.lines || [];
  const employer = payRun.employer || {};

  const rows = lines.map((l) => {
    const emp = l.employee || {};
    const ksErGross = num(l.ksEmployerGrossMinor);
    const esct = num(l.esctMinor);
    const ksErNet = ksErGross - esct; // §3.2: net employer = gross - ESCT
    return [
      emp.irdNumber || '',
      emp.name || '',
      emp.taxCode || '',
      l.startDate || '',
      l.endDate || '',
      dollars2(l.grossMinor),
      dollars2(l.notLiableAccMinor),
      dollars2(l.payeMinor),
      dollars2(l.ksEmployeeMinor),
      dollars2(ksErGross),
      dollars2(esct),
      dollars2(ksErNet),
      dollars2(l.studentLoanMinor),
      dollars2(l.studentLoanExtraMinor),
      dollars2(l.childSupportMinor),
      dollars2(l.donationsMinor),
    ].map(csvCell).join(',');
  });

  // Header comment row (employer + period context) then the column header.
  const headerComment =
    `# EI Return | IRD ${employer.irdNumber || ''} | ${employer.name || ''} | ` +
    `period ${payRun.periodStart || ''}..${payRun.periodEnd || ''} | payday ${payRun.paydayDate || ''}`;

  const content = [headerComment, EI_HEADER.join(','), ...rows].join('\r\n') + '\r\n';

  const meta = {
    kind: 'NZ_EI_RETURN',
    employerIrd: employer.irdNumber || null,
    periodStart: payRun.periodStart || null,
    periodEnd: payRun.periodEnd || null,
    paydayDate: payRun.paydayDate || null,
    employeeCount: lines.length,
    columns: EI_HEADER.slice(),
    totals: {
      grossDollars: dollars2(sumField(lines, 'grossMinor')),
      payeDollars: dollars2(sumField(lines, 'payeMinor')),
      esctDollars: dollars2(sumField(lines, 'esctMinor')),
      ksEmployeeDollars: dollars2(sumField(lines, 'ksEmployeeMinor')),
      ksEmployerGrossDollars: dollars2(sumField(lines, 'ksEmployerGrossMinor')),
      studentLoanDollars: dollars2(sumField(lines, 'studentLoanMinor')),
      // raw cents for downstream reconciliation:
      grossMinor: sumField(lines, 'grossMinor'),
      payeMinor: sumField(lines, 'payeMinor'),
    },
  };

  return {
    fileName: `EI_${employer.irdNumber || 'IRD'}_${payRun.paydayDate || 'payday'}.csv`,
    contentType: 'text/csv',
    meta,
    content,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Direct-credit BANK BATCH (NZ)
//    docs/18 §3.3. We emit a common NZ direct-credit CSV layout (the bank-native
//    CSV most banks accept), with the three 12-char statement fields
//    (Particulars / Code / Reference) and a CONTROL record carrying item count
//    + value hash total (banks require a hash-total control record — IB4B/ABA).
//
// Layout (CSV, CRLF):
//   Detail rows:  DC, payeeAccount, payeeName, amountDollars, particulars,
//                 code, reference
//   Control row:  CTRL, itemCount, totalDollars, hashTotal
//   (hashTotal = sum of the numeric account-number digits — the classic
//    direct-credit account hash that detects truncation/edits.)
//
// Net pay is in CENTS until the formatted amount column. Account format
// BB-bbbb-AAAAAAA-SSS validated (shape only — modulus check lives upstream).
// ───────────────────────────────────────────────────────────────────────────

const NZ_ACCOUNT_RE = /^(\d{2})-(\d{4})-(\d{1,7})-(\d{2,4})$/;
const DC_FIELD_MAX = 12; // particulars / code / reference statement fields

function fitField(s, label) {
  const out = String(s == null ? '' : s).slice(0, DC_FIELD_MAX);
  if (String(s || '').length > DC_FIELD_MAX) {
    throw new RangeError(`${label} exceeds ${DC_FIELD_MAX} chars: "${s}"`);
  }
  return out;
}

/** Hash of account-number digits (truncation guard) — sums every digit. */
function accountHash(account) {
  let h = 0;
  for (const ch of account.replace(/\D/g, '')) h += Number(ch);
  return h;
}

function generateBankBatch(payRun, opts = {}) {
  assertPayRun(payRun);
  const lines = payRun.lines || [];
  const employer = payRun.employer || {};

  const particulars = fitField(opts.particulars || 'SALARY', 'particulars');
  const code = fitField(opts.code || isoPeriodCode(payRun), 'code');
  const reference = fitField(opts.reference || employer.shortName || employer.name || 'PAYROLL', 'reference');

  let totalMinor = 0;
  let hashTotal = 0;
  const detailRows = [];

  lines.forEach((l, i) => {
    const emp = l.employee || {};
    const account = String(emp.bankAccount || '');
    if (!NZ_ACCOUNT_RE.test(account)) {
      throw new RangeError(`line ${i}: invalid NZ account "${account}" (expect BB-bbbb-AAAAAAA-SSS)`);
    }
    const amtMinor = num(l.netPayMinor);
    if (amtMinor <= 0) {
      throw new RangeError(`line ${i}: net pay must be > 0 for a credit, got ${amtMinor}`);
    }
    totalMinor += amtMinor;
    hashTotal += accountHash(account);

    detailRows.push([
      'DC',
      account,
      sanitizeName(emp.name || ''),
      dollars2(amtMinor),
      particulars,
      code,
      reference,
    ].map(csvCell).join(','));
  });

  const control = ['CTRL', String(lines.length), dollars2(totalMinor), String(hashTotal)]
    .map(csvCell)
    .join(',');

  const content = [...detailRows, control].join('\r\n') + '\r\n';

  const meta = {
    kind: 'NZ_DIRECT_CREDIT_BATCH',
    bank: opts.bank || 'generic',
    employerIrd: employer.irdNumber || null,
    itemCount: lines.length,
    particulars,
    code,
    reference,
    control: {
      itemCount: lines.length,
      totalDollars: dollars2(totalMinor),
      totalMinor,
      hashTotal,
    },
  };

  return {
    fileName: `DC_${employer.shortName || 'PAYROLL'}_${payRun.paydayDate || 'batch'}.csv`,
    contentType: 'text/csv',
    meta,
    content,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function assertPayRun(payRun) {
  if (!payRun || typeof payRun !== 'object') throw new TypeError('payRun must be an object');
  if (!Array.isArray(payRun.lines)) throw new TypeError('payRun.lines must be an array');
}

function sanitizeName(s) {
  return String(s).replace(/[",\r\n]+/g, ' ').trim();
}

function isoPeriodCode(payRun) {
  // Compact YYYYMM from periodEnd/paydayDate for the statement "Code" field.
  const d = payRun.periodEnd || payRun.paydayDate || '';
  return d.replace(/-/g, '').slice(0, 8);
}

module.exports = {
  generateEmploymentInformation,
  generateBankBatch,
  _internals: { dollars2, accountHash, NZ_ACCOUNT_RE, EI_HEADER, DC_FIELD_MAX },
};
