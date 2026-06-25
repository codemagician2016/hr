'use strict';

/**
 * bankFormats.js — PURE bank salary-advice (salary-upload) file formatters for
 * India. NO DB, NO I/O, NO Date.now — like money.js / engine.js / variance.js /
 * filing/india.js. The GOLDEN tests in backend/test/disbursement.golden.test.js
 * pin each format's exact bytes for a fixed input; that is THE CONTRACT, so do
 * NOT change a column order / delimiter / header without updating the golden.
 *
 * ── INPUT (the normalized batch the disbursement service assembles) ───────────
 *   beneficiaries: [{
 *     beneficiaryName: String,   // account holder name
 *     accountNumber:   String,   // beneficiary bank account number
 *     ifsc:            String,   // 11-char IFSC (BANK0BRANCH)
 *     amountMinor:     Number,   // net pay to credit, INTEGER MINOR UNITS (paise)
 *     narration:       String,   // statement narration (optional; defaulted)
 *   }, ...]
 *   meta: {
 *     debitAccount:  String,     // company account to debit (some banks omit)
 *     valueDate:     'YYYY-MM-DD',// requested credit date
 *     productCode:   String,     // optional bank product code (defaulted per bank)
 *     batchRef:      String,     // optional batch reference / file id
 *   }
 *
 * ── MONEY RULE ────────────────────────────────────────────────────────────────
 * Amounts arrive as INTEGER MINOR UNITS (paise). We hold paise integers for the
 * running hash/total and convert to rupees-with-2-decimals (money.fromMinor) ONLY
 * at the formatted amount column. NEVER floats for the math.
 *
 * ── OUTPUT ────────────────────────────────────────────────────────────────────
 * Each formatter returns the EXACT file string (no leading BOM). The registry
 * carries the file extension + MIME so the download layer can name/serve it.
 * Line terminator is CRLF (banks' upload parsers expect DOS line endings).
 *
 * Doc basis: the public bulk-salary-upload templates each bank publishes for its
 * corporate net-banking channel. Field SETS below mirror those templates; a
 * tenant's relationship bank may tweak an optional column, but the core
 * beneficiary/account/IFSC/amount columns are stable and what the golden pins.
 */

const { fromMinor, assertMinor, sumMinor } = require('../money');

const CRLF = '\r\n';
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/; // 4 alpha + '0' + 6 alnum
// Beneficiary account number: digits only, 6..18 long. The widest fixed-width
// account column we emit is SBI's (17), so a >18 account would silently overflow
// any flat-file rail — we reject it up-front instead of corrupting the credit.
const ACCOUNT_RE = /^[0-9]{6,18}$/;
// Chars that Excel/Sheets treat as the start of a FORMULA when they lead a cell.
// A cell beginning with one of these (incl. a leading TAB/CR) is neutralized with
// a single leading quote so opening the file can't execute it (CSV-injection guard).
const CSV_FORMULA_LEAD = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Rupees-with-2-decimals from integer paise (no float math). "123456" -> "1234.56" */
function rupees2(amountMinor) {
  assertMinor(amountMinor, 'amountMinor');
  return fromMinor(amountMinor, 2);
}

/**
 * neutralizeFormula — if a cell begins with a formula-trigger char (= + - @ TAB
 * CR), prefix a single quote so a spreadsheet opens it as text, never executes it
 * (standard CSV-injection guard). Empty cells pass through unchanged.
 */
function neutralizeFormula(s) {
  const str = String(s == null ? '' : s);
  return str.length && CSV_FORMULA_LEAD.has(str[0]) ? `'${str}` : str;
}

/** CSV cell: neutralize a leading formula char, then quote+escape if it contains a comma, quote, CR or LF. */
function csvCell(v) {
  const s = neutralizeFormula(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Strip delimiters/newlines from free-text so it can't break a fixed layout, then
 * neutralize a leading formula char (the cleaned text can still land in a CSV via
 * the generic/control rails, so guard it the same as csvCell).
 */
function clean(s) {
  const stripped = String(s == null ? '' : s).replace(/[,"|\r\n]+/g, ' ').trim();
  return neutralizeFormula(stripped);
}

/**
 * Left-justify + pad to width (fixed-width fields). THROWS a tagged 422 on
 * overflow rather than silently truncating — a truncated account/IFSC/name routes
 * or corrupts a real credit, so it must fail loudly. `field` names the column.
 */
function padRight(s, width, field = 'field') {
  const v = String(s == null ? '' : s);
  if (v.length > width) {
    throw bankFmtError('BAD_INPUT', 422, `${field} "${v}" exceeds fixed-width ${width} (got ${v.length}); refusing to truncate.`);
  }
  return v + ' '.repeat(Math.max(0, width - v.length));
}

/**
 * Right-justify zero-padded (numeric fixed-width fields, e.g. amount in paise).
 * THROWS a tagged 422 on overflow rather than dropping the HIGH-order digit —
 * a truncated amount credits the wrong (smaller) sum and breaks the trailer
 * control total, so overflow must fail loudly. `field` names the column.
 */
function padLeftZero(s, width, field = 'field') {
  const v = String(s == null ? '' : s);
  if (v.length > width) {
    throw bankFmtError('BAD_INPUT', 422, `${field} "${v}" exceeds fixed-width ${width} (got ${v.length}); refusing to truncate.`);
  }
  return '0'.repeat(Math.max(0, width - v.length)) + v;
}

/**
 * normalizeInput — validate + default the beneficiary rows and meta. PURE; throws
 * a tagged error (code/statusCode) the service maps to a 422 (never a bare 500).
 * Returns { rows, meta } where rows carry both paise and the formatted rupee
 * string, plus the running total in paise (for the control record).
 */
function normalizeInput(beneficiaries, meta = {}) {
  if (!Array.isArray(beneficiaries)) {
    throw bankFmtError('BAD_INPUT', 400, 'beneficiaries must be an array');
  }
  const rows = beneficiaries.map((b, i) => {
    const name = clean(b && b.beneficiaryName);
    const account = String((b && b.accountNumber) || '').trim();
    const ifsc = String((b && b.ifsc) || '').trim().toUpperCase();
    const amountMinor = b && b.amountMinor;
    if (!name) throw bankFmtError('BAD_INPUT', 422, `line ${i}: beneficiaryName is required`);
    if (!account) throw bankFmtError('BAD_INPUT', 422, `line ${i}: accountNumber is required`);
    if (!ACCOUNT_RE.test(account)) throw bankFmtError('BAD_INPUT', 422, `line ${i}: invalid accountNumber "${account}" (expect 6-18 digits)`);
    if (!IFSC_RE.test(ifsc)) throw bankFmtError('BAD_INPUT', 422, `line ${i}: invalid IFSC "${ifsc}"`);
    assertMinor(amountMinor, `line ${i} amountMinor`);
    if (amountMinor <= 0) throw bankFmtError('BAD_INPUT', 422, `line ${i}: amount must be > 0`);
    return {
      idx: i,
      name,
      account,
      ifsc,
      amountMinor,
      amountRupees: rupees2(amountMinor),
      narration: clean((b && b.narration) || meta.defaultNarration || 'SALARY'),
    };
  });
  const totalMinor = sumMinor(rows.map((r) => r.amountMinor));
  return {
    rows,
    totalMinor,
    totalRupees: rupees2(totalMinor),
    meta: {
      debitAccount: String(meta.debitAccount || '').trim(),
      valueDate: String(meta.valueDate || '').trim(), // 'YYYY-MM-DD'
      valueDateDdmmyyyy: toDdMmYyyy(meta.valueDate),
      productCode: String(meta.productCode || '').trim(),
      batchRef: clean(meta.batchRef || ''),
    },
  };
}

/** 'YYYY-MM-DD' -> 'DD/MM/YYYY' (most IN bank templates want DD/MM/YYYY). '' if absent. */
function toDdMmYyyy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

function bankFmtError(code, statusCode, message) {
  const e = new RangeError(message);
  e.code = code;
  e.statusCode = statusCode;
  return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. HDFC — Enet bulk salary upload (CSV)
//
// HDFC's Enet "bulk upload" salary file is a header-less CSV; each detail row:
//   PymtMode, BeneficiaryCode, BeneficiaryAccountNumber, BeneficiaryName,
//   Amount, DebitAccountNumber, IFSC, PayableLocation/Narration, ValueDate
//   - PymtMode = "NEFT" (or "RTGS" for >= 2,00,000; we emit NEFT as the default
//     low-value rail; high-value selection is a service concern, not the format).
//   - BeneficiaryCode is the file row sequence (1-based) — a stable line id.
//   - Amount = rupees with 2 decimals.
// ─────────────────────────────────────────────────────────────────────────────
function generateHdfc(beneficiaries, meta = {}) {
  const { rows, m } = prep(beneficiaries, meta);
  const lines = rows.map((r) =>
    [
      'NEFT',
      String(r.idx + 1),
      r.account,
      r.name,
      r.amountRupees,
      m.debitAccount,
      r.ifsc,
      r.narration,
      m.valueDateDdmmyyyy,
    ].map(csvCell).join(','),
  );
  return lines.join(CRLF) + CRLF;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. ICICI — Corporate Internet Banking (CIB) bulk salary (CSV, with header)
//
// ICICI CIB's salary template is a CSV WITH a header row:
//   Sr No,Beneficiary Name,Beneficiary Account No,IFSC Code,Amount,
//   Debit Account No,Transaction Type,Value Date,Remarks
//   - Transaction Type = "NEFT". Value Date = DD/MM/YYYY. Amount = rupees.2.
// ─────────────────────────────────────────────────────────────────────────────
const ICICI_HEADER = [
  'Sr No', 'Beneficiary Name', 'Beneficiary Account No', 'IFSC Code', 'Amount',
  'Debit Account No', 'Transaction Type', 'Value Date', 'Remarks',
];
function generateIcici(beneficiaries, meta = {}) {
  const { rows, m } = prep(beneficiaries, meta);
  const body = rows.map((r) =>
    [
      String(r.idx + 1),
      r.name,
      r.account,
      r.ifsc,
      r.amountRupees,
      m.debitAccount,
      'NEFT',
      m.valueDateDdmmyyyy,
      r.narration,
    ].map(csvCell).join(','),
  );
  return [ICICI_HEADER.map(csvCell).join(','), ...body].join(CRLF) + CRLF;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Axis — Corporate / Power Access bulk salary (CSV, with header)
//
// Axis's bulk template header set:
//   PaymentType,BeneficiaryName,BeneficiaryAccountNo,IFSC,Amount,
//   DebitAccountNo,ValueDate,Email,Narration
//   - PaymentType = "NEFT". ValueDate = DD/MM/YYYY. Email blank (we don't pipe
//     PII email into the bank file). Amount = rupees.2.
// ─────────────────────────────────────────────────────────────────────────────
const AXIS_HEADER = [
  'PaymentType', 'BeneficiaryName', 'BeneficiaryAccountNo', 'IFSC', 'Amount',
  'DebitAccountNo', 'ValueDate', 'Email', 'Narration',
];
function generateAxis(beneficiaries, meta = {}) {
  const { rows, m } = prep(beneficiaries, meta);
  const body = rows.map((r) =>
    [
      'NEFT',
      r.name,
      r.account,
      r.ifsc,
      r.amountRupees,
      m.debitAccount,
      m.valueDateDdmmyyyy,
      '',
      r.narration,
    ].map(csvCell).join(','),
  );
  return [AXIS_HEADER.map(csvCell).join(','), ...body].join(CRLF) + CRLF;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Kotak — bulk salary upload (CSV, with header)
//
// Kotak's salary-upload template header set:
//   Client Code,Product Code,Payment Type,Beneficiary Name,Beneficiary Account Number,
//   IFSC Code,Amount,Debit Account Number,Value Date,Narration
//   - Product Code defaults to "NEFT"; Payment Type "NEFT"; Value Date DD/MM/YYYY.
//   - Client Code carries the batch reference (Kotak keys the upload off it).
// ─────────────────────────────────────────────────────────────────────────────
const KOTAK_HEADER = [
  'Client Code', 'Product Code', 'Payment Type', 'Beneficiary Name',
  'Beneficiary Account Number', 'IFSC Code', 'Amount', 'Debit Account Number',
  'Value Date', 'Narration',
];
function generateKotak(beneficiaries, meta = {}) {
  const { rows, m } = prep(beneficiaries, meta);
  const product = m.productCode || 'NEFT';
  const body = rows.map((r) =>
    [
      m.batchRef,
      product,
      'NEFT',
      r.name,
      r.account,
      r.ifsc,
      r.amountRupees,
      m.debitAccount,
      m.valueDateDdmmyyyy,
      r.narration,
    ].map(csvCell).join(','),
  );
  return [KOTAK_HEADER.map(csvCell).join(','), ...body].join(CRLF) + CRLF;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. SBI — Corporate Internet Banking (CINB) salary package (FIXED-WIDTH)
//
// SBI's bulk salary package uses a fixed-width flat file. Each record:
//   RecordType(1) PymtMode(4) BeneAcct(17) IFSC(11) Amount-paise(15, zero-pad)
//   BeneName(40) Narration(30) ValueDate(8 = DDMMYYYY)
//   - RecordType 'D' = detail. PymtMode 'NEFT'. Amount is in PAISE, zero-padded
//     to 15 (SBI's package counts the smallest unit — NO decimal point).
//   - A trailing 'T' control record: RecordType(1) Count(7,zero-pad)
//     TotalPaise(18, zero-pad).
// Fixed-width is byte-exact — the golden pins every column boundary.
// ─────────────────────────────────────────────────────────────────────────────
function generateSbi(beneficiaries, meta = {}) {
  const { norm, rows, m } = prepFull(beneficiaries, meta);
  const detail = rows.map((r) =>
    [
      'D',
      padRight('NEFT', 4, 'pymtMode'),
      padRight(r.account, 17, `line ${r.idx} accountNumber`),
      padRight(r.ifsc, 11, `line ${r.idx} IFSC`),
      // Assert the paise amount fits the 15-wide column BEFORE padding — overflow
      // must fail loudly (a dropped high digit = wrong, smaller credit + broken trailer).
      padLeftZero(String(r.amountMinor), 15, `line ${r.idx} amount(paise)`),
      padRight(r.name, 40, `line ${r.idx} beneficiaryName`),
      padRight(r.narration, 30, `line ${r.idx} narration`),
      padRight(m.valueDateDdmmyyyy.replace(/\//g, ''), 8, 'valueDate'), // DDMMYYYY
    ].join(''),
  );
  const trailer =
    'T' + padLeftZero(String(rows.length), 7, 'count') + padLeftZero(String(norm.totalMinor), 18, 'totalPaise');
  return [...detail, trailer].join(CRLF) + CRLF;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Generic NEFT / RTGS CSV (any bank)
//
// A self-describing CSV any bank's "import" wizard maps. Header row, then detail
// rows, then a CONTROL row (count + total) so a reviewer can checksum the file:
//   Header:  Sr No,Beneficiary Name,Account Number,IFSC,Amount,Payment Mode,
//            Value Date,Narration
//   Control: TOTAL,<count>,,,<totalRupees>,,,
//   - Payment Mode auto-selects RTGS for amounts >= 2,00,000 (the RTGS floor),
//     else NEFT — the only place a format chooses the rail (it is universal, not
//     bank-specific). Value Date DD/MM/YYYY. Amount rupees.2.
// ─────────────────────────────────────────────────────────────────────────────
const RTGS_FLOOR_MINOR = 20000000; // ₹2,00,000 in paise
const NEFT_RTGS_HEADER = [
  'Sr No', 'Beneficiary Name', 'Account Number', 'IFSC', 'Amount',
  'Payment Mode', 'Value Date', 'Narration',
];
function generateNeftRtgs(beneficiaries, meta = {}) {
  const { norm, rows, m } = prepFull(beneficiaries, meta);
  const body = rows.map((r) =>
    [
      String(r.idx + 1),
      r.name,
      r.account,
      r.ifsc,
      r.amountRupees,
      r.amountMinor >= RTGS_FLOOR_MINOR ? 'RTGS' : 'NEFT',
      m.valueDateDdmmyyyy,
      r.narration,
    ].map(csvCell).join(','),
  );
  const control = ['TOTAL', String(rows.length), '', '', norm.totalRupees, '', '', '']
    .map(csvCell)
    .join(',');
  return [NEFT_RTGS_HEADER.map(csvCell).join(','), ...body, control].join(CRLF) + CRLF;
}

// ── internal prep helpers ─────────────────────────────────────────────────────
function prep(beneficiaries, meta) {
  const norm = normalizeInput(beneficiaries, meta);
  return { rows: norm.rows, m: norm.meta };
}
function prepFull(beneficiaries, meta) {
  const norm = normalizeInput(beneficiaries, meta);
  return { norm, rows: norm.rows, m: norm.meta };
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY — bank enum -> { label, fn, fileExt, mime }
// The service + controller look the rail up here; the frontend renders `label`.
// ─────────────────────────────────────────────────────────────────────────────
const formats = Object.freeze({
  HDFC: { label: 'HDFC Bank (Enet)', fn: generateHdfc, fileExt: 'csv', mime: 'text/csv' },
  ICICI: { label: 'ICICI Bank (CIB)', fn: generateIcici, fileExt: 'csv', mime: 'text/csv' },
  AXIS: { label: 'Axis Bank (Corporate)', fn: generateAxis, fileExt: 'csv', mime: 'text/csv' },
  KOTAK: { label: 'Kotak Mahindra Bank', fn: generateKotak, fileExt: 'csv', mime: 'text/csv' },
  SBI: { label: 'State Bank of India (CINB)', fn: generateSbi, fileExt: 'txt', mime: 'text/plain' },
  NEFT_RTGS: { label: 'Generic NEFT / RTGS', fn: generateNeftRtgs, fileExt: 'csv', mime: 'text/csv' },
});

/** List of { value, label } for a bank-picker dropdown (stable order). */
function listBanks() {
  return Object.keys(formats).map((value) => ({ value, label: formats[value].label }));
}

/** True if `bank` is a registered rail. */
function isSupportedBank(bank) {
  return Object.prototype.hasOwnProperty.call(formats, String(bank || ''));
}

/**
 * generate — render a batch for `bank`. Returns { content, fileExt, mime,
 * totalMinor, count }. Throws a tagged error for an unknown bank / bad input.
 */
function generate(bank, beneficiaries, meta = {}) {
  const spec = formats[String(bank || '')];
  if (!spec) throw bankFmtError('UNKNOWN_BANK', 400, `Unknown bank rail "${bank}"`);
  const norm = normalizeInput(beneficiaries, meta); // validate up-front (clear 422)
  const content = spec.fn(beneficiaries, meta);
  return {
    content,
    fileExt: spec.fileExt,
    mime: spec.mime,
    label: spec.label,
    totalMinor: norm.totalMinor,
    count: norm.rows.length,
  };
}

module.exports = {
  formats,
  generate,
  listBanks,
  isSupportedBank,
  // individual formatters (exposed for the golden tests + direct reuse)
  generateHdfc,
  generateIcici,
  generateAxis,
  generateKotak,
  generateSbi,
  generateNeftRtgs,
  // internals exposed for tests
  _internals: {
    normalizeInput,
    rupees2,
    toDdMmYyyy,
    csvCell,
    clean,
    neutralizeFormula,
    padRight,
    padLeftZero,
    IFSC_RE,
    ACCOUNT_RE,
    RTGS_FLOOR_MINOR,
    ICICI_HEADER,
    AXIS_HEADER,
    KOTAK_HEADER,
    NEFT_RTGS_HEADER,
    CRLF,
  },
};
