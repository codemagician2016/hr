'use strict';

/**
 * accounting.js — PURE accounting GL export generator for HR payroll.
 *
 * Turns a pay-run aggregate (the shape returned by payroll/service.js getRun:
 * `{ payRun, lines, totals }`) into a BALANCED double-entry journal, then
 * formats that journal for three accounting systems:
 *
 *   - Xero       → JSON ManualJournal (JournalLines[] with LineAmount sign)
 *   - Tally      → XML (TallyXML <VOUCHER> with ALLLEDGERENTRIES.LIST)
 *   - Zoho Books → CSV (journal import format) and JSON (journal object)
 *
 * Double-entry model (employer's books):
 *
 *   DEBIT  Salary & Wages Expense   = gross earnings (employee-side)
 *   DEBIT  Employer Contributions   = employer statutory cost (PF/ESI/KiwiSaver/ESCT/ACC)
 *   CREDIT Statutory Liabilities     = every statutory deduction + every employer contribution
 *                                      (these are owed to the tax/PF authorities)
 *   CREDIT Other Deductions          = non-statutory deductions (loans, advances, etc.)
 *   CREDIT Net Pay Bank Clearing     = net pay owed to employees
 *
 * Why this balances:
 *   Debits  = gross + employerCost
 *   Credits = statutoryEmployeeDeductions + employerContributions
 *           + otherDeductions + netPay
 *   Since for the employee side  gross = netPay + statutoryEmployeeDeductions
 *                                       + otherDeductions,
 *   and employerCost == employerContributions,
 *   Debits == Credits exactly. We assert this in buildJournal().
 *
 * MONEY: all arithmetic is done in integer MINOR units (cents/paise) to avoid
 * float drift; Prisma Decimal values arrive as strings and are parsed safely.
 * Nothing here touches the DB — it is a deterministic function of its input.
 */

// ---------------------------------------------------------------------------
//  Money helpers — integer minor units
// ---------------------------------------------------------------------------

/** Parse a Decimal-ish value (string | number | Prisma.Decimal | null) to a
 *  Number of MAJOR units. Never throws; treats null/blank/NaN as 0. */
function toMajor(value) {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'object' && typeof value.toString === 'function'
    ? Number(value.toString())
    : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Major units → integer minor units (rounded, scale 2). */
function toMinor(value, scale = 2) {
  const factor = Math.pow(10, scale);
  return Math.round(toMajor(value) * factor);
}

/** Integer minor units → major-unit string with fixed scale (for output). */
function minorToStr(minor, scale = 2) {
  const factor = Math.pow(10, scale);
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / factor);
  const frac = String(abs % factor).padStart(scale, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** Minor → Number major (for JSON numeric fields). */
function minorToNum(minor, scale = 2) {
  return Number(minorToStr(minor, scale));
}

// ---------------------------------------------------------------------------
//  Default chart of accounts. Caller may override via opts.accounts.
// ---------------------------------------------------------------------------

const DEFAULT_ACCOUNTS = Object.freeze({
  salaryExpense:        { code: '6000', name: 'Salaries & Wages' },
  employerContribution: { code: '6010', name: 'Employer Statutory Contributions' },
  statutoryLiability:   { code: '2100', name: 'Statutory Liabilities Payable' },
  otherDeductions:      { code: '2110', name: 'Employee Deductions Payable' },
  netPayClearing:       { code: '2200', name: 'Net Pay Bank Clearing' },
});

// Statutory rollup fields on a PayRunLine, split by who bears them.
const EMPLOYEE_STATUTORY = ['pfEmployee', 'esiEmployee', 'pt', 'tds', 'paye', 'kiwiSaverEmployee', 'studentLoan'];
const EMPLOYER_STATUTORY = ['pfEmployer', 'esiEmployer', 'kiwiSaverEmployer', 'esct', 'accLevy'];

// ---------------------------------------------------------------------------
//  Core: build the balanced journal from a pay-run aggregate
// ---------------------------------------------------------------------------

/**
 * buildJournal(runAggregate, opts) → balanced journal
 *
 * @param {object} runAggregate  { payRun, lines } (as from getRun)
 * @param {object} [opts]        { accounts, scale }
 * @returns {{
 *   meta: object,
 *   currency: string,
 *   scale: number,
 *   lines: Array<{ account, accountName, type, debitMinor, creditMinor }>,
 *   totals: { debitMinor, creditMinor },
 *   balanced: boolean,
 *   statutoryBreakdown: object,
 * }}
 * @throws if debits !== credits (a generator bug; must never ship unbalanced)
 */
function buildJournal(runAggregate, opts = {}) {
  const accounts = { ...DEFAULT_ACCOUNTS, ...(opts.accounts || {}) };
  const scale = opts.scale != null ? opts.scale : 2;

  const payRun = runAggregate.payRun || {};
  const lines = Array.isArray(runAggregate.lines)
    ? runAggregate.lines
    : (Array.isArray(payRun.lines) ? payRun.lines : []);

  const currency = payRun.currencyCode || (lines[0] && lines[0].currencyCode) || 'INR';

  let grossMinor = 0;
  let netMinor = 0;
  let employeeStatMinor = 0;
  let employerStatMinor = 0;
  let totalDeductionsMinor = 0;

  const statutoryBreakdown = {}; // field → minor

  for (const ln of lines) {
    grossMinor += toMinor(ln.grossEarnings, scale);
    netMinor += toMinor(ln.netPay, scale);
    totalDeductionsMinor += toMinor(ln.totalDeductions, scale);

    for (const f of EMPLOYEE_STATUTORY) {
      const m = toMinor(ln[f], scale);
      if (m) {
        employeeStatMinor += m;
        statutoryBreakdown[f] = (statutoryBreakdown[f] || 0) + m;
      }
    }
    for (const f of EMPLOYER_STATUTORY) {
      const m = toMinor(ln[f], scale);
      if (m) {
        employerStatMinor += m;
        statutoryBreakdown[f] = (statutoryBreakdown[f] || 0) + m;
      }
    }
  }

  // Non-statutory employee deductions = totalDeductions − employee statutory.
  // (e.g. loan repayments, salary advances). totalDeductions is the full
  // employee-side reduction from gross to net.
  let otherDeductionsMinor = totalDeductionsMinor - employeeStatMinor;
  // Defensive: if rollups disagree (e.g. statutory not snapshotted), clamp to
  // keep the journal internally consistent. gross = net + totalDeductions is
  // the invariant the engine guarantees per line.
  if (otherDeductionsMinor < 0) otherDeductionsMinor = 0;

  const journal = [];

  // DEBITS
  push(journal, accounts.salaryExpense, 'DEBIT', grossMinor, 0);
  push(journal, accounts.employerContribution, 'DEBIT', employerStatMinor, 0);

  // CREDITS
  // Statutory liabilities = employee statutory deductions + employer contributions
  push(journal, accounts.statutoryLiability, 'CREDIT', 0, employeeStatMinor + employerStatMinor);
  push(journal, accounts.otherDeductions, 'CREDIT', 0, otherDeductionsMinor);
  push(journal, accounts.netPayClearing, 'CREDIT', 0, netMinor);

  const debitMinor = journal.reduce((s, l) => s + l.debitMinor, 0);
  const creditMinor = journal.reduce((s, l) => s + l.creditMinor, 0);

  if (debitMinor !== creditMinor) {
    const err = new Error(
      `GL journal does not balance: debits=${minorToStr(debitMinor, scale)} ` +
      `credits=${minorToStr(creditMinor, scale)} (run ${payRun.code || payRun.id || '?'})`
    );
    err.code = 'GL_UNBALANCED';
    err.debitMinor = debitMinor;
    err.creditMinor = creditMinor;
    throw err;
  }

  return {
    meta: {
      payRunId: payRun.id || null,
      payRunCode: payRun.code || null,
      periodStart: isoDate(payRun.periodStart),
      periodEnd: isoDate(payRun.periodEnd),
      payDate: isoDate(payRun.payDate),
      entity: payRun.entity ? (payRun.entity.legalName || payRun.entity.code) : null,
      headcount: lines.length,
      narration: `Payroll ${payRun.code || ''} ${isoDate(payRun.periodStart) || ''} to ${isoDate(payRun.periodEnd) || ''}`.trim(),
    },
    currency,
    scale,
    lines: journal.filter((l) => l.debitMinor !== 0 || l.creditMinor !== 0),
    totals: { debitMinor, creditMinor },
    balanced: debitMinor === creditMinor,
    statutoryBreakdown,
  };
}

function push(arr, account, type, debitMinor, creditMinor) {
  arr.push({
    account: account.code,
    accountName: account.name,
    type,
    debitMinor,
    creditMinor,
  });
}

function isoDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
//  Formatters
// ---------------------------------------------------------------------------

/** Xero ManualJournal JSON. Xero uses LineAmount with sign: negative = debit,
 *  positive = credit (Xero's accounting convention for journals). */
function toXero(journal) {
  const { scale } = journal;
  return {
    Narration: journal.meta.narration,
    Date: journal.meta.payDate || journal.meta.periodEnd,
    LineAmountTypes: 'NoTax',
    Status: 'POSTED',
    JournalLines: journal.lines.map((l) => {
      const isDebit = l.debitMinor > 0;
      const amountMinor = isDebit ? l.debitMinor : l.creditMinor;
      return {
        // Xero: negative LineAmount = debit, positive = credit.
        LineAmount: isDebit ? -minorToNum(amountMinor, scale) : minorToNum(amountMinor, scale),
        AccountCode: l.account,
        Description: l.accountName,
      };
    }),
  };
}

/** Tally XML import — a JOURNAL voucher with ALLLEDGERENTRIES.LIST entries.
 *  Tally convention: ISDEEMEDPOSITIVE=Yes + negative AMOUNT for debits;
 *  ISDEEMEDPOSITIVE=No + positive AMOUNT for credits. */
function toTally(journal) {
  const { scale } = journal;
  const date = (journal.meta.payDate || journal.meta.periodEnd || '').replace(/-/g, '');
  const entries = journal.lines.map((l) => {
    const isDebit = l.debitMinor > 0;
    const amtMinor = isDebit ? l.debitMinor : l.creditMinor;
    const amt = minorToStr(amtMinor, scale);
    return [
      '        <ALLLEDGERENTRIES.LIST>',
      `          <LEDGERNAME>${xmlEscape(l.accountName)}</LEDGERNAME>`,
      `          <ISDEEMEDPOSITIVE>${isDebit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`,
      `          <AMOUNT>${isDebit ? '-' + amt : amt}</AMOUNT>`,
      '        </ALLLEDGERENTRIES.LIST>',
    ].join('\n');
  }).join('\n');

  return [
    '<ENVELOPE>',
    '  <HEADER>',
    '    <TALLYREQUEST>Import Data</TALLYREQUEST>',
    '  </HEADER>',
    '  <BODY>',
    '    <IMPORTDATA>',
    '      <REQUESTDESC>',
    '        <REPORTNAME>Vouchers</REPORTNAME>',
    '      </REQUESTDESC>',
    '      <REQUESTDATA>',
    '        <TALLYMESSAGE>',
    `          <VOUCHER VCHTYPE="Journal" ACTION="Create">`,
    `            <DATE>${date}</DATE>`,
    `            <NARRATION>${xmlEscape(journal.meta.narration)}</NARRATION>`,
    `            <VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>`,
    `            <REFERENCE>${xmlEscape(journal.meta.payRunCode || '')}</REFERENCE>`,
    entries.split('\n').map((line) => '    ' + line).join('\n'),
    '          </VOUCHER>',
    '        </TALLYMESSAGE>',
    '      </REQUESTDATA>',
    '    </IMPORTDATA>',
    '  </BODY>',
    '</ENVELOPE>',
  ].join('\n');
}

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Zoho Books journal — JSON object (matches their Journals API shape). */
function toZohoJson(journal) {
  const { scale } = journal;
  return {
    journal_date: journal.meta.payDate || journal.meta.periodEnd,
    reference_number: journal.meta.payRunCode || '',
    notes: journal.meta.narration,
    currency_code: journal.currency,
    line_items: journal.lines.map((l) => {
      const isDebit = l.debitMinor > 0;
      const amtMinor = isDebit ? l.debitMinor : l.creditMinor;
      return {
        account_name: l.accountName,
        account_code: l.account,
        debit_or_credit: isDebit ? 'debit' : 'credit',
        amount: minorToNum(amtMinor, scale),
      };
    }),
  };
}

/** Zoho Books journal — CSV import format. One row per line item. */
function toZohoCsv(journal) {
  const { scale } = journal;
  const header = [
    'Journal Date', 'Reference Number', 'Notes', 'Currency',
    'Account', 'Account Code', 'Debit', 'Credit',
  ];
  const rows = journal.lines.map((l) => {
    const debit = l.debitMinor > 0 ? minorToStr(l.debitMinor, scale) : '';
    const credit = l.creditMinor > 0 ? minorToStr(l.creditMinor, scale) : '';
    return [
      journal.meta.payDate || journal.meta.periodEnd || '',
      journal.meta.payRunCode || '',
      journal.meta.narration,
      journal.currency,
      l.accountName,
      l.account,
      debit,
      credit,
    ].map(csvCell).join(',');
  });
  return [header.map(csvCell).join(','), ...rows].join('\n');
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------------------------------------------------------------------------
//  One-shot: aggregate → format
// ---------------------------------------------------------------------------

const FORMATS = Object.freeze(['xero', 'tally', 'zoho-json', 'zoho-csv']);

/**
 * exportRun(runAggregate, format, opts) → { format, contentType, body, journal }
 * `body` is a string for tally/zoho-csv, an object for xero/zoho-json.
 */
function exportRun(runAggregate, format, opts = {}) {
  const journal = buildJournal(runAggregate, opts);
  switch ((format || '').toLowerCase()) {
    case 'xero':
      return { format: 'xero', contentType: 'application/json', body: toXero(journal), journal };
    case 'tally':
      return { format: 'tally', contentType: 'application/xml', body: toTally(journal), journal };
    case 'zoho-json':
    case 'zoho':
      return { format: 'zoho-json', contentType: 'application/json', body: toZohoJson(journal), journal };
    case 'zoho-csv':
      return { format: 'zoho-csv', contentType: 'text/csv', body: toZohoCsv(journal), journal };
    default: {
      const err = new Error(`Unknown accounting export format: ${format}. Supported: ${FORMATS.join(', ')}`);
      err.code = 'UNKNOWN_FORMAT';
      throw err;
    }
  }
}

module.exports = {
  buildJournal,
  exportRun,
  toXero,
  toTally,
  toZohoJson,
  toZohoCsv,
  FORMATS,
  DEFAULT_ACCOUNTS,
  // exposed for tests / reuse
  toMinor,
  minorToStr,
};
