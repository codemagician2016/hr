'use strict';

/**
 * ctcPdf.js — branded, downloadable "Compensation Statement / CTC Breakup" PDF
 * generator (pure, no DB, no network).
 *
 * `renderCtcPdf({ employee, business, revision, currency }) -> Promise<Buffer>`
 *
 * Mirrors the payslipPdf.js pattern: a buffer-collection PDFKit document
 * resolved to a Promise<Buffer>, a branded header band, defensive money/date
 * helpers, A4 portrait layout. It opens no DB connection and reaches no network:
 * the caller resolves the secured compensation revision + the employee/business
 * identity (already masked per the viewer's F5 compVisibility), and this module
 * turns that into a PDF Buffer.
 *
 * MASKING-AWARE (the load-bearing security property): the document only ever
 * renders the figures present on the `revision` it is handed. The hr-admin
 * controller passes a maskCompensation() envelope, so a RANGE_ONLY viewer's
 * `revision` carries NO absolute money (no ctcAnnual/grossMonthly/netMonthly,
 * no per-line amounts) — only a `range` band. We therefore branch on what is
 * present:
 *   - `revision.absolute` (ABSOLUTE | SELF_ONLY) → full component waterfall.
 *   - `revision.range` only (RANGE_ONLY)         → a BANDED statement (compa-ratio
 *     / range penetration / grade min-mid-max) with an explicit notice; NO
 *     absolute salary is ever drawn. The caller decides whether to refuse
 *     instead — but if it does hand us a masked revision, we never leak.
 *
 * Robustness contract (tested): never throws on a minimal/empty revision or
 * missing arrays/fields — every accessor is defensive and falls back cleanly.
 *
 * MONEY: revision amounts are MAJOR-unit Decimal strings/numbers already
 * (e.g. "1234.56"). We only re-group them for display (thousands separators +
 * the country symbol); we never re-derive or re-scale them here. Annual columns
 * are computed as monthly * 12 ONLY when an explicit annual amount is absent.
 */

const PDFDocument = require('pdfkit');

// ── currency display ────────────────────────────────────────────────────────
// India -> ₹ + en-IN grouping (lakh/crore); New Zealand -> $ + en-NZ grouping.
// Anything else falls back to the ISO code prefix with plain en-US grouping.
const CURRENCY = {
  INR: { symbol: '₹', locale: 'en-IN' },
  NZD: { symbol: '$', locale: 'en-NZ' },
  USD: { symbol: '$', locale: 'en-US' },
  AUD: { symbol: '$', locale: 'en-AU' },
  GBP: { symbol: '£', locale: 'en-GB' },
  EUR: { symbol: '€', locale: 'en-IE' },
};

/**
 * Format a major-unit decimal STRING (or number) as a grouped money string with
 * the currency symbol. Defensive: a missing/garbage amount renders as the symbol
 * + "0.00" rather than throwing. Negatives keep the sign before the symbol.
 */
function money(amount, currencyCode) {
  const cc = String(currencyCode || '').toUpperCase();
  const meta = CURRENCY[cc] || null;
  const symbol = meta ? meta.symbol : (cc ? cc + ' ' : '');
  const locale = meta ? meta.locale : 'en-US';

  const num = Number(amount);
  if (!Number.isFinite(num)) {
    const raw = (amount === 0 || amount) ? String(amount) : '0.00';
    return `${symbol}${raw}`;
  }
  const neg = num < 0;
  const grouped = Math.abs(num).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${neg ? '-' : ''}${symbol}${grouped}`;
}

/** Decimal|number|string|{toNumber} → finite number or null (display only). */
function toNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

// ── identity helpers ────────────────────────────────────────────────────────

/** Best-effort human name from an employee-ish object. */
function employeeName(employee) {
  const e = employee || {};
  const joined = [e.firstName, e.middleName, e.lastName].filter(Boolean).join(' ').trim();
  return joined || e.name || e.preferredName || e.displayName || e.fullName || e.code || 'Employee';
}

function businessName(business) {
  const b = business || {};
  return b.name || b.legalName || b.displayName || b.tradingName || 'Company';
}

/** A department/designation may be a string or a { name } relation object. */
function valueOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.name || v.title || v.label || v.code || '';
  return String(v);
}

/** ISO date passthrough — revision dates may be "YYYY-MM-DD" strings or Date. */
function fmtDate(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  try {
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toISOString().slice(0, 10);
  } catch (_e) {
    return '';
  }
}

// ── layout constants (A4 portrait) ──────────────────────────────────────────
const PAGE = { size: 'A4', margin: 40 };
const COLOR = {
  brand: '#1F3A5F',
  accent: '#2E6F95',
  text: '#1A1A1A',
  muted: '#6B7280',
  line: '#D1D5DB',
  zebra: '#F3F5F8',
  netBg: '#1F3A5F',
  ctcBg: '#13283F',
};

// ── line normalisation ───────────────────────────────────────────────────────
// A revision line may arrive as { component:{ code,name,category }, amountMonthly,
// amountAnnual } (DB include shape) or as a flat { code, name, category, amount,
// amountMonthly }. Resolve a stable { label, category, monthly, annual }.
function lineLabel(l) {
  if (!l) return 'Component';
  return (
    (l.component && (l.component.name || l.component.code))
    || l.name || l.label || l.code
    || 'Component'
  );
}

function lineCategory(l) {
  if (!l) return 'EARNING';
  return (l.component && l.component.category) || l.category || 'EARNING';
}

function lineMonthly(l) {
  if (!l) return null;
  return toNum(l.amountMonthly != null ? l.amountMonthly : l.amount);
}

function lineAnnual(l) {
  if (!l) return null;
  const a = toNum(l.amountAnnual);
  if (a != null) return a;
  const m = lineMonthly(l);
  return m != null ? Math.round(m * 12 * 100) / 100 : null;
}

/**
 * Split the revision lines into the three display groups (earnings, employee
 * deductions, employer contributions) keyed off component.category.
 */
function splitLines(lines) {
  const earnings = [];
  const deductions = [];
  const employer = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    const cat = lineCategory(l);
    if (cat === 'EARNING' || cat === 'REIMBURSEMENT') earnings.push(l);
    else if (cat === 'EMPLOYER_COST') employer.push(l);
    else deductions.push(l);
  }
  return { earnings, deductions, employer };
}

function sumMonthly(lines) {
  return (lines || []).reduce((s, l) => s + (lineMonthly(l) || 0), 0);
}

// ── render ───────────────────────────────────────────────────────────────────

/**
 * renderCtcPdf — build the Compensation Statement PDF and resolve to a Buffer.
 *
 * @param {Object}  args
 * @param {Object} [args.employee] identity ({ firstName,lastName,name,code,
 *        department?, designation?/jobTitle? })
 * @param {Object} [args.business] tenant identity ({ name/legalName, logoPath? })
 * @param {Object} [args.revision] the masked/secured comp record:
 *        { effectiveFrom?, currencyCode?, revisionReason?,
 *          absolute?:{ ctcAnnual, grossMonthly, netMonthly },  // unmasked
 *          ctcAnnual?, grossMonthly?, netMonthly?,              // flat fallback
 *          lines?:[{ component?, amountMonthly, amountAnnual }],
 *          range?:{ min, mid, max, compaRatio, rangePenetration } } // banded
 * @param {Object} [args.breakup] alias for `revision` (either key accepted).
 * @param {string} [args.currency] currency code override (else revision.currencyCode).
 * @returns {Promise<Buffer>}
 */
function renderCtcPdf({ employee, business, revision, breakup, currency } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const rev = revision || breakup || {};
      const abs = rev.absolute || null;
      const currencyCode = currency || rev.currencyCode || (abs && abs.currencyCode) || '';

      // A masked (RANGE_ONLY) revision carries NO absolute money and NO per-line
      // amounts — only a `range` band. Detect that posture so we render a banded
      // statement instead of (impossible) absolute figures.
      const hasAbsolute = !!(abs && (abs.ctcAnnual != null || abs.grossMonthly != null || abs.netMonthly != null))
        || rev.ctcAnnual != null || rev.grossMonthly != null;
      const banded = !hasAbsolute && !!rev.range;

      const doc = new PDFDocument({
        size: PAGE.size,
        margin: PAGE.margin,
        info: {
          Title: `Compensation Statement — ${employeeName(employee)}`.trim(),
          Author: businessName(business),
          Subject: 'Compensation Statement / CTC Breakup',
          Creator: 'DriftHR',
        },
      });

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const contentW = right - left;

      drawHeader(doc, { left, contentW, business, rev, currencyCode, banded });
      drawEmployeeBlock(doc, { left, contentW, employee, rev });

      if (banded) {
        drawBandedStatement(doc, { left, contentW, currencyCode, rev });
      } else {
        drawAbsoluteStatement(doc, { left, contentW, currencyCode, rev, abs });
      }

      drawFooter(doc, { left, right });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ── the full (unmasked) component waterfall ──────────────────────────────────
function drawAbsoluteStatement(doc, { left, contentW, currencyCode, rev, abs }) {
  const { earnings, deductions, employer } = splitLines(rev.lines);
  const a = abs || {};

  const ctcAnnual = toNum(a.ctcAnnual != null ? a.ctcAnnual : rev.ctcAnnual);
  const grossMonthly = toNum(a.grossMonthly != null ? a.grossMonthly : rev.grossMonthly);
  const netMonthlyRaw = toNum(a.netMonthly != null ? a.netMonthly : rev.netMonthly);

  // Summary band: total CTC (annual) headline.
  drawCtcHeadline(doc, { left, contentW, currencyCode, ctcAnnual, grossMonthly });

  // EARNINGS — monthly + annual columns.
  drawComponentTable(doc, {
    left, contentW, currencyCode,
    title: 'Earnings',
    rows: earnings,
    totalLabel: 'Gross Earnings',
    totalMonthly: grossMonthly != null ? grossMonthly : sumMonthly(earnings),
  });

  // EMPLOYEE DEDUCTIONS.
  if (deductions.length) {
    drawComponentTable(doc, {
      left, contentW, currencyCode,
      title: 'Employee Deductions',
      rows: deductions,
      totalLabel: 'Total Deductions',
      totalMonthly: sumMonthly(deductions),
    });
  }

  // NET (monthly) — prominent. Prefer the stored net; else gross − deductions.
  let netMonthly = netMonthlyRaw;
  if (netMonthly == null && grossMonthly != null) {
    netMonthly = Math.round((grossMonthly - sumMonthly(deductions)) * 100) / 100;
  }
  drawNetPay(doc, { left, contentW, currencyCode, net: netMonthly });

  // EMPLOYER CONTRIBUTIONS (cost to company — not paid to the employee).
  if (employer.length) {
    drawComponentTable(doc, {
      left, contentW, currencyCode,
      title: 'Employer Contributions (cost to company — not paid to you)',
      rows: employer,
      totalLabel: 'Total Employer Cost',
      totalMonthly: sumMonthly(employer),
      muted: true,
    });
  }

  // TOTAL CTC footer band (annual) — the cost-to-company roll-up.
  drawCtcTotal(doc, { left, contentW, currencyCode, ctcAnnual });
}

// ── the masked (RANGE_ONLY) banded statement — NO absolute money ─────────────
function drawBandedStatement(doc, { left, contentW, currencyCode, rev }) {
  ensureSpace(doc, 60);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR.accent)
    .text('Banded compensation view', left, doc.y, { width: contentW });
  doc.y += 4;
  doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.muted)
    .text(
      'You do not have permission to view this employee’s absolute salary figures. '
      + 'This statement shows only the pay-band position (compa-ratio / range penetration). '
      + 'Absolute amounts are intentionally omitted.',
      left, doc.y, { width: contentW },
    );
  doc.y += 8;

  const range = rev.range || {};
  const rows = [
    ['Grade band (min)', range.min != null ? money(range.min, currencyCode) : '—'],
    ['Grade band (mid)', range.mid != null ? money(range.mid, currencyCode) : '—'],
    ['Grade band (max)', range.max != null ? money(range.max, currencyCode) : '—'],
    ['Compa-ratio', range.compaRatio != null ? String(range.compaRatio) : '—'],
    ['Range penetration', range.rangePenetration != null
      ? `${Math.round(range.rangePenetration * 1000) / 10}%` : '—'],
  ];
  if (rev.delta && rev.delta.band) rows.push(['Last change (band)', String(rev.delta.band)]);

  // Two-column key/value grid (band MIN/MID/MAX are grade-range figures, NOT the
  // individual's absolute pay — they are a legitimate part of the RANGE_ONLY view).
  drawKeyValueGrid(doc, { left, contentW, rows });
}

// ── drawing primitives ───────────────────────────────────────────────────────

function drawHeader(doc, { left, contentW, business, rev, currencyCode, banded }) {
  const top = doc.y;
  doc.save();
  doc.rect(left, top, contentW, 64).fill(COLOR.brand);
  doc.restore();

  // Optional logo (only a readable local path; URLs skipped to stay network-free).
  const logoX = left + 14;
  let textX = logoX;
  const logoPath = business && (business.logoPath || business.logoFile);
  if (logoPath) {
    try {
      doc.image(logoPath, logoX, top + 12, { fit: [40, 40] });
      textX = logoX + 52;
    } catch (_e) { /* fall back to name text */ }
  }

  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(18)
    .text(businessName(business), textX, top + 12, {
      width: contentW - (textX - left) - 150, lineBreak: false, ellipsis: true,
    });
  doc.font('Helvetica').fontSize(10).fillColor('#DCE5F0')
    .text(banded ? 'Compensation Statement (banded)' : 'Compensation Statement', textX, top + 36);

  // Right-aligned effective date + currency inside the band.
  const eff = fmtDate(rev.effectiveFrom);
  doc.font('Helvetica').fontSize(9).fillColor('#DCE5F0');
  doc.text(`Effective: ${eff || '—'}`, left, top + 16, { width: contentW - 14, align: 'right' });
  if (currencyCode) {
    doc.text(`Currency: ${currencyCode}`, left, top + 30, { width: contentW - 14, align: 'right' });
  }
  if (rev.revisionReason) {
    doc.text(`Reason: ${prettyKey(rev.revisionReason)}`, left, top + 44, { width: contentW - 14, align: 'right' });
  }

  doc.fillColor(COLOR.text);
  doc.y = top + 64 + 14;
}

function drawEmployeeBlock(doc, { left, contentW, employee, rev }) {
  const e = employee || {};
  const rows = [
    ['Employee', employeeName(employee)],
    ['Employee code', e.code || ''],
    ['Department', valueOf(e.department) || ''],
    ['Designation', valueOf(e.designation) || valueOf(e.jobTitle) || ''],
    ['Effective from', fmtDate(rev.effectiveFrom)],
  ].filter((r) => r[1] !== '' && r[1] != null);

  drawKeyValueGrid(doc, { left, contentW, rows, divider: true });
}

/** Two-column key/value grid (also used by the employee block + banded view). */
function drawKeyValueGrid(doc, { left, contentW, rows, divider }) {
  const startY = doc.y;
  const colW = contentW / 2;
  let i = 0;
  for (const [label, val] of rows) {
    const col = i % 2;
    const rowIdx = Math.floor(i / 2);
    const x = left + col * colW;
    const y = startY + rowIdx * 16;
    doc.font('Helvetica').fontSize(8).fillColor(COLOR.muted)
      .text(`${label}`, x, y, { width: 110, continued: false });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.text)
      .text(String(val), x + 112, y, { width: colW - 120, lineBreak: false, ellipsis: true });
    i += 1;
  }
  const rowCount = Math.ceil(rows.length / 2);
  doc.y = startY + Math.max(rowCount, 1) * 16 + 8;
  if (divider) { hr(doc, left, doc.y, contentW); doc.y += 10; }
}

/** Summary headline band — Total CTC (annual) + gross (monthly). */
function drawCtcHeadline(doc, { left, contentW, currencyCode, ctcAnnual, grossMonthly }) {
  ensureSpace(doc, 56);
  const y = doc.y;
  const h = 46;
  doc.save();
  doc.rect(left, y, contentW, h).fill(COLOR.zebra);
  doc.restore();
  doc.font('Helvetica').fontSize(8).fillColor(COLOR.muted)
    .text('COST TO COMPANY (ANNUAL)', left + 14, y + 8);
  doc.font('Helvetica-Bold').fontSize(18).fillColor(COLOR.brand)
    .text(money(ctcAnnual, currencyCode), left + 14, y + 20);
  if (grossMonthly != null) {
    doc.font('Helvetica').fontSize(8).fillColor(COLOR.muted)
      .text('GROSS (MONTHLY)', left, y + 8, { width: contentW - 14, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(13).fillColor(COLOR.text)
      .text(money(grossMonthly, currencyCode), left, y + 20, { width: contentW - 14, align: 'right' });
  }
  doc.fillColor(COLOR.text);
  doc.y = y + h + 14;
}

/** Three-column component table: Component | Monthly | Annual + a total row. */
function drawComponentTable(doc, { left, contentW, currencyCode, title, rows, totalLabel, totalMonthly, muted }) {
  ensureSpace(doc, 64);
  const colW = (contentW - 20) / 2 * 0.42; // each money column width
  const annualX = left + contentW - colW - 10;
  const monthlyX = annualX - colW - 10;
  const labelX = left + 10;
  const labelW = monthlyX - labelX - 8;

  // Title.
  doc.font('Helvetica-Bold').fontSize(11).fillColor(muted ? COLOR.accent : COLOR.brand)
    .text(title, left, doc.y, { width: contentW });
  doc.y += 4;

  // Header strip.
  let y = doc.y;
  doc.save();
  doc.rect(left, y, contentW, 18).fill(COLOR.zebra);
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.muted);
  doc.text('Component', labelX, y + 5, { width: labelW });
  doc.text('Monthly', monthlyX, y + 5, { width: colW, align: 'right' });
  doc.text('Annual', annualX, y + 5, { width: colW, align: 'right' });
  y += 18;
  doc.y = y;

  if (!rows.length) {
    doc.fillColor(COLOR.muted).fontSize(8).text('No items.', labelX, y + 4, { width: contentW - 20 });
    y += 16;
    doc.y = y;
  }

  let zebra = false;
  for (const r of rows) {
    ensureSpace(doc, 24);
    y = doc.y;
    const rowH = 16;
    if (zebra) {
      doc.save();
      doc.rect(left, y, contentW, rowH).fill(COLOR.zebra);
      doc.restore();
    }
    zebra = !zebra;
    doc.font('Helvetica').fontSize(9).fillColor(COLOR.text)
      .text(lineLabel(r), labelX, y + 4, { width: labelW, lineBreak: false, ellipsis: true });
    doc.text(money(lineMonthly(r), currencyCode), monthlyX, y + 4, { width: colW, align: 'right' });
    doc.text(money(lineAnnual(r), currencyCode), annualX, y + 4, { width: colW, align: 'right' });
    y += rowH;
    doc.y = y;
  }

  // Total row.
  ensureSpace(doc, 28);
  y = doc.y;
  doc.save();
  doc.moveTo(left, y).lineTo(left + contentW, y).lineWidth(0.75).strokeColor(COLOR.line).stroke();
  doc.restore();
  y += 4;
  const totalAnnual = totalMonthly != null ? Math.round(totalMonthly * 12 * 100) / 100 : null;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(muted ? COLOR.accent : COLOR.brand);
  doc.text(totalLabel, labelX, y + 2, { width: labelW });
  doc.text(money(totalMonthly, currencyCode), monthlyX, y + 2, { width: colW, align: 'right' });
  doc.text(money(totalAnnual, currencyCode), annualX, y + 2, { width: colW, align: 'right' });
  y += 22;
  doc.y = y;
}

function drawNetPay(doc, { left, contentW, currencyCode, net }) {
  ensureSpace(doc, 50);
  const y = doc.y;
  const h = 38;
  doc.save();
  doc.rect(left, y, contentW, h).fill(COLOR.netBg);
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#FFFFFF')
    .text('NET (MONTHLY)', left + 14, y + 11, { width: contentW / 2 });
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#FFFFFF')
    .text(money(net, currencyCode), left, y + 9, { width: contentW - 16, align: 'right' });
  doc.fillColor(COLOR.text);
  doc.y = y + h + 14;
}

function drawCtcTotal(doc, { left, contentW, currencyCode, ctcAnnual }) {
  ensureSpace(doc, 46);
  const y = doc.y;
  const h = 34;
  doc.save();
  doc.rect(left, y, contentW, h).fill(COLOR.ctcBg);
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#FFFFFF')
    .text('TOTAL CTC (ANNUAL)', left + 14, y + 10, { width: contentW / 2 });
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#FFFFFF')
    .text(money(ctcAnnual, currencyCode), left, y + 8, { width: contentW - 16, align: 'right' });
  doc.fillColor(COLOR.text);
  doc.y = y + h + 14;
}

function drawFooter(doc, { left, right }) {
  const y = doc.page.height - doc.page.margins.bottom - 18;
  hr(doc, left, y, right - left);
  doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.muted)
    .text(
      `System-generated compensation statement — no signature required. Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC.`,
      left, y + 5, { width: right - left, align: 'center' },
    );
  doc.fillColor(COLOR.text);
}

// ── small utilities ───────────────────────────────────────────────────────────

function hr(doc, x, y, w) {
  doc.save();
  doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.5).strokeColor(COLOR.line).stroke();
  doc.restore();
}

/** Add a page when the cursor is too close to the bottom. */
function ensureSpace(doc, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom - 24;
  if (doc.y + needed > bottom) doc.addPage();
}

function prettyKey(k) {
  return String(k)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = {
  renderCtcPdf,
  _internals: { money, toNum, employeeName, businessName, fmtDate, splitLines, lineLabel, lineAnnual },
};
