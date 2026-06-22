'use strict';

/**
 * india.js — PURE statutory file generators for India payroll filings.
 *
 * Generators are pure functions of a *pay-run aggregate*: no DB, no I/O, no
 * Date.now. Each takes a `payRun` object and returns
 *   { fileName, contentType, meta, content }
 * where `content` is the file text (Buffer-able string) and `meta` is a small
 * header of derived totals/counts (handy for maker-checker previews).
 *
 * MONEY RULE: every amount on the input lines is INTEGER MINOR UNITS (paise).
 * We keep paise integers right up to the formatted output, then convert to the
 * units each file requires (ECR & ESIC want whole rupees; 24Q FVU wants
 * rupees with 2 decimals). Conversion uses money.fromMinor / integer rupee
 * rounding — never floats for the running math.
 *
 * Pay-run aggregate shape (documented contract — independent of the compute
 * module's internal return shape so the generators stay decoupled):
 *
 *   payRun = {
 *     period:      'YYYY-MM'  (wage month, e.g. '2026-05'),
 *     establishment: {                      // EPFO / ESIC registration
 *       pfEstablishmentCode, pfExtension, esicCode, ...
 *     },
 *     entity:      { tan, name, ... },      // for 24Q (per-TAN return)
 *     quarter:     'Q1'|'Q2'|'Q3'|'Q4',     // for 24Q
 *     lines: [ {
 *       employee: { uan, name, esicIp, pan, code },
 *       // all amounts in PAISE (integer minor units):
 *       grossWagesMinor,            // EPF "gross wages"
 *       epfWagesMinor,              // EPF wage base (a/c 1)
 *       epsWagesMinor,              // EPS wage base (a/c 10, capped 15k)
 *       edliWagesMinor,             // EDLI wage base (a/c 21, capped 15k)
 *       epfEeMinor,                 // a/c 1 EE share
 *       epfErMinor,                 // a/c 1 ER share (diff of EE - EPS)
 *       epsMinor,                   // a/c 10
 *       ncpDays,                    // non-contributory period days
 *       refundAdvanceMinor,         // refund of advances
 *       // ESI:
 *       esiGrossMinor, esiEeMinor, esiErMinor,
 *       // TDS:
 *       tdsMinor, taxableMinor, ...
 *     } ]
 *   }
 *
 * Doc basis: docs/05-compliance-india.md §4.6 (ECR), §5 (ESI), §7.4 (24Q/138),
 * §12.4 (output-file generators — "ECR pipe-delimited EPFO spec, ESIC CSV,
 * FVU-input flat file"). EPFO per-account nearest-rupee rounding: §16.6.
 */

const { fromMinor } = require('../money');

const PAISE = 100;

/** Round integer paise to whole rupees (nearest, ₹0.50 up) — EPFO §16.6 / §4.6. */
function paiseToRupeesNearest(minor) {
  if (!Number.isInteger(minor)) throw new TypeError(`paise must be integer, got ${minor}`);
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const r = Math.floor((abs + PAISE / 2) / PAISE); // half-up
  return neg ? -r : r;
}

/** Sum a numeric field over the lines (paise). */
function sumField(lines, field) {
  let t = 0;
  for (const l of lines) {
    const v = l[field] || 0;
    if (!Number.isInteger(v)) throw new TypeError(`${field} must be integer paise, got ${v}`);
    t += v;
  }
  return t;
}

function num(v) {
  return Number.isInteger(v) ? v : 0;
}

// ───────────────────────────────────────────────────────────────────────────
// 1. ECR — EPFO Electronic Challan-cum-Return
//    docs/05 §4.6 + §12.4 ("ECR pipe-delimited EPFO spec").
//
// EPFO's ECR is a text file of member lines. Each line has the canonical
// 11 fields, delimited by the literal token "#~#":
//
//   UAN #~# MemberName #~# GrossWages #~# EPFWages #~# EPSWages #~# EDLIWages
//       #~# EPFContribRemitted #~# EPSContribRemitted #~# EPFEPSDiffRemitted
//       #~# NCPDays #~# RefundOfAdvances
//
//   - EPFContribRemitted  = a/c 1 EE share (EPF)
//   - EPSContribRemitted  = a/c 10 (EPS, 8.33% capped at 15k)
//   - EPFEPSDiffRemitted  = a/c 1 ER share = (EPF ER 3.67%) i.e. ER total - EPS
//   All wages/contribs are WHOLE RUPEES (EPFO rounds each account to nearest ₹).
//   Lines are CRLF-separated; the file carries no header row (the challan
//   summary is computed separately — we surface it in `meta`).
// ───────────────────────────────────────────────────────────────────────────

const ECR_DELIM = '#~#';

function generateEcr(payRun) {
  assertPayRun(payRun);
  const lines = payRun.lines || [];

  const rows = lines.map((l) => {
    const uan = String((l.employee && l.employee.uan) || '');
    const name = sanitize((l.employee && l.employee.name) || '');
    const gross = paiseToRupeesNearest(num(l.grossWagesMinor));
    const epfWage = paiseToRupeesNearest(num(l.epfWagesMinor));
    const epsWage = paiseToRupeesNearest(num(l.epsWagesMinor));
    const edliWage = paiseToRupeesNearest(num(l.edliWagesMinor));
    const epfRemit = paiseToRupeesNearest(num(l.epfEeMinor));
    const epsRemit = paiseToRupeesNearest(num(l.epsMinor));
    const epfEpsDiff = paiseToRupeesNearest(num(l.epfErMinor));
    const ncp = num(l.ncpDays);
    const refund = paiseToRupeesNearest(num(l.refundAdvanceMinor));

    return [
      uan, name, gross, epfWage, epsWage, edliWage,
      epfRemit, epsRemit, epfEpsDiff, ncp, refund,
    ].join(ECR_DELIM);
  });

  const content = rows.join('\r\n') + (rows.length ? '\r\n' : '');

  // Challan summary (whole rupees) — what the EPFO portal totals back.
  const meta = {
    kind: 'EPFO_ECR',
    period: payRun.period,
    establishmentCode: (payRun.establishment && payRun.establishment.pfEstablishmentCode) || null,
    memberCount: lines.length,
    delimiter: ECR_DELIM,
    totals: {
      grossWagesRupees: paiseToRupeesNearest(sumField(lines, 'grossWagesMinor')),
      epfWagesRupees: paiseToRupeesNearest(sumField(lines, 'epfWagesMinor')),
      epsWagesRupees: paiseToRupeesNearest(sumField(lines, 'epsWagesMinor')),
      epfRemittedRupees: lines.reduce((s, l) => s + paiseToRupeesNearest(num(l.epfEeMinor)), 0),
      epsRemittedRupees: lines.reduce((s, l) => s + paiseToRupeesNearest(num(l.epsMinor)), 0),
      epfEpsDiffRupees: lines.reduce((s, l) => s + paiseToRupeesNearest(num(l.epfErMinor)), 0),
    },
  };

  return {
    fileName: `ECR_${meta.establishmentCode || 'EST'}_${payRun.period}.txt`,
    contentType: 'text/plain',
    meta,
    content,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 2. ESIC — monthly contribution file (CSV)
//    docs/05 §5 (EE 0.75%, ER 3.25%, ₹21k ceiling) + §12.4 ("ESIC CSV").
//
// ESIC's monthly contribution upload (MC file) is a CSV with the columns the
// portal's bulk template expects. Amounts are WHOLE RUPEES (ESIC rounds up to
// the next rupee per account — handled upstream; we just format).
//
//   IP Number, IP Name, No. of Days, Total Monthly Wages,
//   Reason Code (0 = working), Last Working Day
//   (+ we append EE/ER contribution columns for our maker-checker preview)
// ───────────────────────────────────────────────────────────────────────────

const ESIC_HEADER = [
  'IPNumber',
  'IPName',
  'NoOfDays',
  'TotalMonthlyWages',
  'ReasonCode',
  'LastWorkingDay',
  'EEContribution',
  'ERContribution',
];

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function generateEsic(payRun) {
  assertPayRun(payRun);
  const lines = payRun.lines || [];
  // Only ESI-covered members appear (esiGrossMinor present / covered flag).
  const covered = lines.filter((l) => (l.esiGrossMinor || 0) > 0 && l.esiCovered !== false);

  const rows = covered.map((l) => {
    const ip = (l.employee && l.employee.esicIp) || '';
    const name = (l.employee && l.employee.name) || '';
    const days = num(l.workedDays != null ? l.workedDays : l.paidDays) || 0;
    const wagesRupees = paiseToRupeesNearest(num(l.esiGrossMinor));
    const reason = num(l.esiReasonCode); // 0 = working/contributing
    const lwd = l.lastWorkingDay || '';
    const ee = paiseToRupeesNearest(num(l.esiEeMinor));
    const er = paiseToRupeesNearest(num(l.esiErMinor));
    return [ip, name, days, wagesRupees, reason, lwd, ee, er].map(csvCell).join(',');
  });

  const content = [ESIC_HEADER.join(','), ...rows].join('\r\n') + '\r\n';

  const meta = {
    kind: 'ESIC_MC',
    period: payRun.period,
    esicCode: (payRun.establishment && payRun.establishment.esicCode) || null,
    coveredCount: covered.length,
    columns: ESIC_HEADER.slice(),
    totals: {
      esiGrossRupees: covered.reduce((s, l) => s + paiseToRupeesNearest(num(l.esiGrossMinor)), 0),
      esiEeRupees: covered.reduce((s, l) => s + paiseToRupeesNearest(num(l.esiEeMinor)), 0),
      esiErRupees: covered.reduce((s, l) => s + paiseToRupeesNearest(num(l.esiErMinor)), 0),
    },
  };
  meta.totals.esiTotalRupees = meta.totals.esiEeRupees + meta.totals.esiErRupees;

  return {
    fileName: `ESIC_${meta.esicCode || 'CODE'}_${payRun.period}.csv`,
    contentType: 'text/csv',
    meta,
    content,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Form 24Q / 138 — quarterly TDS return (FVU-oriented field set)
//    docs/05 §7.4 + §12.4 ("FVU-input flat file for 24Q/138").
//
// The FVU input is a pipe-delimited (^) flat file with line-type records:
//   FH — File Header  (record type 'FH')
//   BH — Batch Header (one per TAN/quarter; carries TAN, form 24Q, FY, period)
//   CD — Challan Detail (deposit challans; here one aggregate challan)
//   DD — Deductee Detail (Annexure I: per-employee TDS for the quarter)
// Amounts are RUPEES with 2 decimals. We model the field SET the RPU/FVU needs
// rather than the byte-exact govt layout (which the tenant's FVU finalises).
// ───────────────────────────────────────────────────────────────────────────

const FVU_DELIM = '^';
const QUARTER_MONTHS = {
  Q1: 'Apr-Jun', Q2: 'Jul-Sep', Q3: 'Oct-Dec', Q4: 'Jan-Mar',
};

function rupees2(minor) {
  return fromMinor(num(minor), 2); // paise -> "1234.56"
}

function generate24Q(payRun) {
  assertPayRun(payRun);
  const lines = payRun.lines || [];
  const entity = payRun.entity || {};
  const quarter = payRun.quarter || 'Q1';
  const fy = payRun.financialYear || '';
  const tan = entity.tan || '';

  const totalTdsMinor = sumField(lines, 'tdsMinor');
  const totalTaxableMinor = sumField(lines, 'taxableMinor');

  const records = [];
  // FH — file header
  records.push(['FH', 'NSDL', 'TDS/TCS', 'FVU', 'Regular'].join(FVU_DELIM));
  // BH — batch header (per TAN/form/quarter)
  records.push([
    'BH', tan, '24Q', '138', fy, quarter, QUARTER_MONTHS[quarter] || '',
    String(lines.length), rupees2(totalTdsMinor),
  ].join(FVU_DELIM));
  // CD — challan detail (single aggregate deposit challan for the quarter)
  records.push([
    'CD', '1', rupees2(totalTdsMinor), rupees2(0), rupees2(0), rupees2(totalTdsMinor),
    entity.challanBsrCode || '', entity.challanDate || '', entity.challanSerial || '',
  ].join(FVU_DELIM));
  // DD — deductee detail (Annexure I), one per employee
  lines.forEach((l, i) => {
    const emp = l.employee || {};
    records.push([
      'DD',
      String(i + 1),
      emp.pan || 'PANNOTAVBL',
      sanitize(emp.name || ''),
      '92B', // section 92B = salary
      rupees2(num(l.taxableMinor)),
      rupees2(num(l.tdsMinor)),
      rupees2(num(l.tdsMinor)), // tax deposited
      emp.code || '',
    ].join(FVU_DELIM));
  });

  const content = records.join('\r\n') + '\r\n';

  const meta = {
    kind: 'FORM_24Q_FVU',
    form: '24Q/138',
    tan,
    financialYear: fy,
    quarter,
    quarterMonths: QUARTER_MONTHS[quarter] || null,
    deducteeCount: lines.length,
    delimiter: FVU_DELIM,
    annexureII: quarter === 'Q4', // Q4 carries annual breakup (§7.4)
    totals: {
      taxableRupees: rupees2(totalTaxableMinor),
      tdsRupees: rupees2(totalTdsMinor),
      tdsMinor: totalTdsMinor,
    },
  };

  return {
    fileName: `24Q_${tan || 'TAN'}_${fy || 'FY'}_${quarter}.fvu`,
    contentType: 'text/plain',
    meta,
    content,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function assertPayRun(payRun) {
  if (!payRun || typeof payRun !== 'object') {
    throw new TypeError('payRun must be an object');
  }
  if (!Array.isArray(payRun.lines)) {
    throw new TypeError('payRun.lines must be an array');
  }
}

/** Strip delimiters/newlines from free-text so they can't break the layout. */
function sanitize(s) {
  return String(s).replace(/[#~^|\r\n]+/g, ' ').trim();
}

module.exports = {
  generateEcr,
  generateEsic,
  generate24Q,
  // exposed for tests / reuse
  _internals: { paiseToRupeesNearest, rupees2, ECR_DELIM, FVU_DELIM, ESIC_HEADER },
};
