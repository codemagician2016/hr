'use strict';

/**
 * payslipPdf.js — branded, downloadable PDF payslip generator (pure, no DB).
 *
 * `renderPayslipPdf({ payslip, employee, business }) -> Promise<Buffer>`
 *
 * The PDF is rendered ENTIRELY from the payslip's frozen `snapshotJson` (the
 * immutable source of truth) plus the supplied identity blocks. It opens no DB
 * connection and reaches no network: the caller resolves the secured payslip +
 * the employee/business identity, and this module turns that into a PDF Buffer.
 *
 * Robustness contract (tested): never throws on a minimal/empty snapshot or
 * missing arrays/fields — every accessor is defensive and falls back cleanly.
 *
 * MONEY: snapshot amounts are MAJOR-unit decimal strings already (e.g.
 * "1234.56"). We only re-group them for display (thousands separators + the
 * country symbol); we never re-derive or re-scale them here.
 */

const PDFDocument = require('pdfkit');

// ── currency display ────────────────────────────────────────────────────────
// India -> ₹ + en-IN grouping (lakh/crore); New Zealand -> $ + en-NZ grouping.
// Anything else falls back to the ISO code prefix with plain en-US grouping.
const CURRENCY = {
  INR: { symbol: '₹', locale: 'en-IN' }, // ₹
  NZD: { symbol: '$', locale: 'en-NZ' },
  USD: { symbol: '$', locale: 'en-US' },
  AUD: { symbol: '$', locale: 'en-AU' },
  GBP: { symbol: '£', locale: 'en-GB' }, // £
  EUR: { symbol: '€', locale: 'en-IE' }, // €
};

/**
 * Format a major-unit decimal STRING (or number) as a grouped money string with
 * the currency symbol. Defensive: a missing/garbage amount renders as the
 * symbol + "0.00" rather than throwing. Negatives keep the sign before symbol.
 */
function money(amount, currencyCode) {
  const cc = String(currencyCode || '').toUpperCase();
  const meta = CURRENCY[cc] || null;
  const symbol = meta ? meta.symbol : (cc ? cc + ' ' : '');
  const locale = meta ? meta.locale : 'en-US';

  const n = Number(amount);
  if (!Number.isFinite(n)) {
    // Unparseable — surface the raw value if present, else a zero.
    const raw = (amount === 0 || amount) ? String(amount) : '0.00';
    return `${symbol}${raw}`;
  }
  const neg = n < 0;
  const grouped = Math.abs(n).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${neg ? '-' : ''}${symbol}${grouped}`;
}

// ── identity helpers ────────────────────────────────────────────────────────

/** Best-effort human name from an employee-ish object or the snapshot. */
function employeeName(employee, payslip) {
  const e = employee || (payslip && payslip.employee) || {};
  const joined = [e.firstName, e.middleName, e.lastName].filter(Boolean).join(' ').trim();
  return (
    joined ||
    e.name ||
    e.preferredName ||
    e.displayName ||
    e.fullName ||
    e.code ||
    'Employee'
  );
}

function businessName(business) {
  const b = business || {};
  return b.name || b.legalName || b.displayName || b.tradingName || 'Company';
}

/** ISO date string passthrough — snapshot dates are already "YYYY-MM-DD". */
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
  brand: '#1F3A5F', // deep slate blue
  accent: '#2E6F95',
  text: '#1A1A1A',
  muted: '#6B7280',
  line: '#D1D5DB',
  zebra: '#F3F5F8',
  netBg: '#1F3A5F',
};

/**
 * renderPayslipPdf — build the payslip PDF and resolve to a Buffer.
 *
 * @param {Object}  args
 * @param {Object}  args.payslip   the Payslip row ({ code, snapshotJson, yptdJson, employee? })
 * @param {Object} [args.employee] identity ({ firstName,lastName,name,code, department?, designation? })
 * @param {Object} [args.business] tenant identity ({ name/legalName, logoUrl?, ... })
 * @returns {Promise<Buffer>}
 */
function renderPayslipPdf({ payslip, employee, business, brand, pdfPassword } = {}) {
  return new Promise((resolve, reject) => {
    // Program P1.2 — tenant branding finally reaches the payslip: valid hex
    // colors from TenantBrand override the module defaults for THIS render
    // (drawing is fully synchronous, so the save/restore cannot interleave
    // with another render), and the logo arrives as pre-fetched bytes.
    const HEX = /^#[0-9a-fA-F]{6}$/;
    const prevBrandColor = COLOR.brand;
    const prevAccentColor = COLOR.accent;
    if (brand && HEX.test(brand.primaryColor || '')) COLOR.brand = brand.primaryColor;
    if (brand && HEX.test(brand.accentColor || '')) COLOR.accent = brand.accentColor;
    const restoreColors = () => { COLOR.brand = prevBrandColor; COLOR.accent = prevAccentColor; };
    try {
      const slip = payslip || {};
      const snap = slip.snapshotJson || {};
      const currencyCode = snap.currencyCode || slip.currencyCode || '';

      const doc = new PDFDocument({
        size: PAGE.size,
        margin: PAGE.margin,
        // Program P1.2 — optional tenant-configured PDF password (DOB mode);
        // ownerPassword mirrors it so the doc is fully locked to the employee.
        ...(pdfPassword ? { userPassword: pdfPassword, ownerPassword: pdfPassword } : {}),
        info: {
          Title: `Payslip ${slip.code || ''}`.trim(),
          Author: businessName(business),
          Subject: 'Payslip',
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

      // ── HEADER ──────────────────────────────────────────────────────────
      drawHeader(doc, { left, right, contentW, business, snap, slip, currencyCode, logoBytes: brand && brand.logoBytes ? brand.logoBytes : null });

      // ── EMPLOYEE BLOCK ──────────────────────────────────────────────────
      drawEmployeeBlock(doc, { left, right, contentW, employee, payslip: slip });

      // ── EARNINGS ────────────────────────────────────────────────────────
      const earnings = Array.isArray(snap.earnings) ? snap.earnings : [];
      drawAmountTable(doc, {
        left, contentW, currencyCode,
        title: 'Earnings',
        rows: earnings.map((e) => ({
          label: (e && (e.label || e.code)) || 'Earning',
          amount: e && e.amount,
        })),
        totalLabel: 'Gross Earnings',
        totalAmount: snap.gross,
      });

      // ── DEDUCTIONS ──────────────────────────────────────────────────────
      const deds = Array.isArray(snap.employeeDeductions) ? snap.employeeDeductions : [];
      drawAmountTable(doc, {
        left, contentW, currencyCode,
        title: 'Deductions',
        rows: deds.map((d) => ({
          label: (d && (d.label || d.code)) || 'Deduction',
          amount: d && d.amount,
          tag: d && d.statutory ? 'Statutory' : null,
        })),
        totalLabel: 'Total Deductions',
        totalAmount: snap.totalDeductions,
      });

      // ── NET PAY (prominent) ─────────────────────────────────────────────
      drawNetPay(doc, { left, contentW, currencyCode, net: snap.net });

      // ── EMPLOYER CONTRIBUTIONS (informational) ──────────────────────────
      const er = Array.isArray(snap.employerContributions) ? snap.employerContributions : [];
      if (er.length || snap.totalEmployerCost != null) {
        drawAmountTable(doc, {
          left, contentW, currencyCode,
          title: 'Employer Contributions (informational — not deducted from net)',
          rows: er.map((c) => ({
            label: (c && (c.label || c.code)) || 'Contribution',
            amount: c && c.amount,
          })),
          totalLabel: 'Total Employer Cost',
          totalAmount: snap.totalEmployerCost,
          muted: true,
        });
      }

      // ── YEAR-TO-DATE (optional) ─────────────────────────────────────────
      drawYtd(doc, { left, contentW, currencyCode, yptd: slip.yptdJson });

      // ── FOOTER ──────────────────────────────────────────────────────────
      drawFooter(doc, { left, right });

      doc.end();
      restoreColors(); // drawing is synchronous — safe to restore here
    } catch (err) {
      restoreColors();
      reject(err);
    }
  });
}

// ── drawing primitives ──────────────────────────────────────────────────────

function drawHeader(doc, { left, right, contentW, business, snap, slip, currencyCode, logoBytes }) {
  const top = doc.y;
  // Brand band.
  doc.save();
  doc.rect(left, top, contentW, 64).fill(COLOR.brand);
  doc.restore();

  // Optional logo (only if it's a local path we can read; URLs are skipped to
  // keep this network-free). Falls back to the business name text.
  const logoX = left + 14;
  let textX = logoX;
  const logoPath = business && (business.logoPath || business.logoFile);
  // Program P1.2 — the tenant's uploaded logo (pre-fetched bytes) wins; a local
  // path remains the fallback; both fail soft to the name text.
  const logoSource = logoBytes || logoPath;
  if (logoSource) {
    try {
      doc.image(logoSource, logoX, top + 12, { fit: [40, 40] });
      textX = logoX + 52;
    } catch (_e) { /* fall back to name text */ }
  }

  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(18)
    .text(businessName(business), textX, top + 12, { width: contentW - (textX - left) - 120, lineBreak: false, ellipsis: true });
  doc.font('Helvetica').fontSize(10).fillColor('#DCE5F0')
    .text('Payslip', textX, top + 36);

  // Right-aligned period + pay date inside the band.
  const period = `${fmtDate(snap.periodStart)}  to  ${fmtDate(snap.periodEnd)}`.trim();
  const payDate = fmtDate(snap.payDate);
  doc.font('Helvetica').fontSize(9).fillColor('#DCE5F0');
  doc.text(`Pay period: ${period || '—'}`, left, top + 14, { width: contentW - 14, align: 'right' });
  doc.text(`Pay date: ${payDate || '—'}`, left, top + 28, { width: contentW - 14, align: 'right' });
  if (currencyCode) {
    doc.text(`Currency: ${currencyCode}`, left, top + 42, { width: contentW - 14, align: 'right' });
  }

  doc.fillColor(COLOR.text);
  doc.y = top + 64 + 14;
}

function drawEmployeeBlock(doc, { left, contentW, employee, payslip }) {
  const e = employee || payslip.employee || {};
  const name = employeeName(employee, payslip);
  const rows = [
    ['Employee', name],
    ['Employee code', e.code || ''],
    ['Department', valueOf(e.department) || ''],
    ['Designation', valueOf(e.designation) || valueOf(e.jobTitle) || ''],
    ['Payslip no.', payslip.code || ''],
  ].filter((r) => r[1] !== '' && r[1] != null);

  const startY = doc.y;
  const colW = contentW / 2;
  let i = 0;
  for (const [label, val] of rows) {
    const col = i % 2;
    const rowIdx = Math.floor(i / 2);
    const x = left + col * colW;
    const y = startY + rowIdx * 16;
    doc.font('Helvetica').fontSize(8).fillColor(COLOR.muted)
      .text(`${label}`, x, y, { width: 90, continued: false });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.text)
      .text(String(val), x + 92, y, { width: colW - 100, lineBreak: false, ellipsis: true });
    i += 1;
  }
  const rowCount = Math.ceil(rows.length / 2);
  doc.y = startY + Math.max(rowCount, 1) * 16 + 8;
  hr(doc, left, doc.y, contentW);
  doc.y += 10;
}

/** Generic two-column amount table with a header strip, zebra rows + a total. */
function drawAmountTable(doc, { left, contentW, currencyCode, title, rows, totalLabel, totalAmount, muted }) {
  ensureSpace(doc, 60);
  const amountColW = 150;
  const labelX = left + 10;
  const amountX = left + contentW - amountColW - 10;

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
  doc.text('Component', labelX, y + 5, { width: contentW - amountColW - 30 });
  doc.text('Amount', amountX, y + 5, { width: amountColW, align: 'right' });
  y += 18;

  // Rows.
  doc.font('Helvetica').fontSize(9).fillColor(COLOR.text);
  if (!rows.length) {
    doc.fillColor(COLOR.muted).fontSize(8).text('No items.', labelX, y + 4, { width: contentW - 20 });
    y += 16;
  }
  let zebra = false;
  for (const r of rows) {
    ensureSpace(doc, 24, () => { y = doc.y; });
    const rowH = 16;
    if (zebra) {
      doc.save();
      doc.rect(left, y, contentW, rowH).fill(COLOR.zebra);
      doc.restore();
    }
    zebra = !zebra;
    doc.font('Helvetica').fontSize(9).fillColor(COLOR.text);
    let label = r.label;
    doc.text(label, labelX, y + 4, { width: contentW - amountColW - 60, lineBreak: false, ellipsis: true });
    if (r.tag) {
      doc.font('Helvetica-Oblique').fontSize(7).fillColor(COLOR.accent)
        .text(r.tag, labelX, y + 4, { width: contentW - amountColW - 30, align: 'left', indent: doc.widthOfString(label) + 8 });
    }
    doc.font('Helvetica').fontSize(9).fillColor(COLOR.text)
      .text(money(r.amount, currencyCode), amountX, y + 4, { width: amountColW, align: 'right' });
    y += rowH;
  }

  // Total row.
  doc.save();
  doc.moveTo(left, y).lineTo(left + contentW, y).lineWidth(0.75).strokeColor(COLOR.line).stroke();
  doc.restore();
  y += 4;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(muted ? COLOR.accent : COLOR.brand);
  doc.text(totalLabel, labelX, y + 2, { width: contentW - amountColW - 30 });
  doc.text(money(totalAmount, currencyCode), amountX, y + 2, { width: amountColW, align: 'right' });
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
    .text('NET PAY', left + 14, y + 11, { width: contentW / 2 });
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#FFFFFF')
    .text(money(net, currencyCode), left, y + 9, { width: contentW - 16, align: 'right' });
  doc.fillColor(COLOR.text);
  doc.y = y + h + 14;
}

function drawYtd(doc, { left, contentW, currencyCode, yptd }) {
  if (!yptd || typeof yptd !== 'object') return;
  const entries = flattenYtd(yptd);
  if (!entries.length) return;
  ensureSpace(doc, 50);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR.brand)
    .text('Year to Date', left, doc.y, { width: contentW });
  doc.y += 4;
  let y = doc.y;
  const colW = contentW / 2;
  let i = 0;
  for (const [label, val] of entries) {
    const col = i % 2;
    const rowIdx = Math.floor(i / 2);
    const x = left + col * colW;
    const ry = y + rowIdx * 16;
    ensureSpace(doc, (rowIdx + 1) * 16 + 4);
    doc.font('Helvetica').fontSize(8).fillColor(COLOR.muted)
      .text(prettyKey(label), x, ry, { width: colW * 0.55 });
    const display = isMoneyish(label, val) ? money(val, currencyCode) : String(val);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.text)
      .text(display, x + colW * 0.55, ry, { width: colW * 0.42, align: 'right', lineBreak: false, ellipsis: true });
    i += 1;
  }
  const rowCount = Math.ceil(entries.length / 2);
  doc.y = y + rowCount * 16 + 12;
}

function drawFooter(doc, { left, right }) {
  const y = doc.page.height - doc.page.margins.bottom - 18;
  hr(doc, left, y, right - left);
  doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.muted)
    .text(
      `System-generated payslip — no signature required. Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC.`,
      left, y + 5, { width: right - left, align: 'center' },
    );
  doc.fillColor(COLOR.text);
}

// ── small utilities ─────────────────────────────────────────────────────────

function hr(doc, x, y, w) {
  doc.save();
  doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.5).strokeColor(COLOR.line).stroke();
  doc.restore();
}

/** Add a page when the cursor is too close to the bottom; run onBreak after. */
function ensureSpace(doc, needed, onBreak) {
  const bottom = doc.page.height - doc.page.margins.bottom - 24;
  if (doc.y + needed > bottom) {
    doc.addPage();
    if (typeof onBreak === 'function') onBreak();
  }
}

/** A department/designation may be a string or a { name } relation object. */
function valueOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.name || v.title || v.label || v.code || '';
  return String(v);
}

function prettyKey(k) {
  return String(k)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isMoneyish(key, val) {
  if (typeof val !== 'string' && typeof val !== 'number') return false;
  const n = Number(val);
  if (!Number.isFinite(n)) return false;
  const k = String(key).toLowerCase();
  return /gross|net|pay|deduc|tax|pf|epf|esi|paye|contrib|earn|amount|ytd|cost|salary/.test(k);
}

/** YTD JSON is free-form; surface flat scalar fields (skip nested objects). */
function flattenYtd(yptd) {
  const out = [];
  for (const [k, v] of Object.entries(yptd)) {
    if (v == null) continue;
    if (typeof v === 'object') {
      // one level of nesting (e.g. { earnings: { gross: "..." } })
      for (const [k2, v2] of Object.entries(v)) {
        if (v2 == null || typeof v2 === 'object') continue;
        out.push([`${k} ${k2}`, v2]);
      }
      continue;
    }
    out.push([k, v]);
  }
  return out;
}

module.exports = { renderPayslipPdf, _internals: { money, employeeName, businessName, fmtDate } };
