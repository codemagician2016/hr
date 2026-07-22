'use strict';

/*
 * tabular.js — SHARED tabular export library for the Reports Platform.
 *
 * exportTabular(format, { title, columns, rows, totals? }) →
 *   { fileName, contentType, content }        (Promise — PDF is stream-based)
 *
 *   columns: [{ key, label, type? ('date'|'string'|'number'|'money'|'enum'), align? }]
 *   rows:    [{ <key>: value, ... }]          plain objects keyed by column.key
 *   totals:  { <key>: number, ... }           optional footer row (TOTAL)
 *
 * PURE (no prisma, no HTTP): unit-testable without a database. Generalises the
 * statutory-registers exporter trio (registers/exporters/{csv,xlsx,pdf}Export.js):
 *   - the SAME formula-injection neutralisation (leading =,+,-,@,\t,\r gets a
 *     leading quote — registers/exporters/csvExport.js, mirroring the F18 import
 *     neutraliser) because report cells carry employee-controlled free text and
 *     the file is opened in Excel/LibreOffice/Sheets;
 *   - the SAME UTF-8 BOM on CSV so ₹/½ render in Excel;
 *   - the SAME lazy-require + CSV fallback for the OPTIONAL `xlsx` dep;
 *   - the SAME pdfkit A4-landscape table pattern (wrapped repeating header,
 *     zebra rows, totals footer) plus "Page N of M" page numbers.
 *
 * Money arrives in MAJOR units as numbers (datasets normalise Decimal → Number);
 * formatting to 2-dp display text happens HERE, at export time only.
 */

const FORMATS = Object.freeze(['CSV', 'XLSX', 'PDF']);

// ── cell text formatting (type-aware, display only) ──────────────────────────

/** Render a raw row value to display text according to the column type. */
function formatCell(value, col = {}) {
  if (value == null) return '';
  const type = col.type || 'string';
  if (type === 'date') {
    const d = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return String(value);
  }
  if (type === 'money') {
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(n)) return n.toFixed(2);
    return String(value);
  }
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(n)) {
      // Trim float noise but keep real decimals (e.g. 1.5 days).
      return Number.isInteger(n) ? String(n) : String(Math.round(n * 10000) / 10000);
    }
    return String(value);
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

// ── formula-injection neutralisation + CSV escaping (registers copy) ─────────

const FORMULA_LEAD = new Set(['=', '+', '-', '@', '\t', '\r']);

function neutralizeFormula(value) {
  const s = String(value == null ? '' : value);
  if (s.length === 0) return s;
  return FORMULA_LEAD.has(s[0]) ? `'${s}` : s;
}

/** RFC-4180 cell escaping (quote + double inner quotes), formula guard first. */
function csvCell(v) {
  const s = neutralizeFormula(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ── shared row materialisation ───────────────────────────────────────────────

function slugify(title) {
  return String(title || 'report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'report';
}

/** Build display-text matrix: header labels, body rows, optional TOTAL row. */
function toDisplayMatrix({ columns, rows, totals }) {
  const cols = Array.isArray(columns) ? columns : [];
  const body = (Array.isArray(rows) ? rows : []).map((r) => cols.map((c) => formatCell(r[c.key], c)));
  let totalRow = null;
  if (totals && typeof totals === 'object' && cols.some((c) => totals[c.key] != null)) {
    totalRow = cols.map((c, i) => {
      if (totals[c.key] != null) return formatCell(totals[c.key], c);
      return i === 0 ? 'TOTAL' : '';
    });
    // Guarantee the TOTAL marker even when column 0 itself carries a total.
    if (totals[cols[0] && cols[0].key] == null && totalRow[0] === '') totalRow[0] = 'TOTAL';
  }
  return { header: cols.map((c) => String(c.label != null ? c.label : c.key)), body, totalRow };
}

// ── CSV ──────────────────────────────────────────────────────────────────────

function buildCsv({ title, columns, rows, totals, fileBase }) {
  const { header, body, totalRow } = toDisplayMatrix({ columns, rows, totals });
  const lines = [];
  if (title) {
    lines.push(csvCell(title));
    lines.push(''); // blank separator
  }
  lines.push(header.map(csvCell).join(','));
  for (const r of body) lines.push(r.map(csvCell).join(','));
  if (totalRow) lines.push(totalRow.map(csvCell).join(','));
  return {
    fileName: `${fileBase || slugify(title)}.csv`,
    contentType: 'text/csv; charset=utf-8',
    content: '﻿' + lines.join('\r\n'), // BOM so Excel renders ₹/½ correctly
  };
}

// ── XLSX (lazy optional dep, CSV fallback) ───────────────────────────────────

function tryRequireXlsx() {
  try {
    // eslint-disable-next-line global-require
    return require('xlsx');
  } catch (_e) {
    return null;
  }
}

/**
 * buildXlsx(payload, opts) — `opts.xlsxModule` overrides the lazy require
 * (pass null in tests to force the CSV fallback). Falls back to CSV (with a
 * .csv name + text/csv type) when `xlsx` is unavailable — the export always
 * succeeds with a spreadsheet-openable artefact, no hard new dependency.
 */
function buildXlsx(payload, opts = {}) {
  const XLSX = opts.xlsxModule !== undefined ? opts.xlsxModule : tryRequireXlsx();
  if (!XLSX) return buildCsv(payload);

  const { title, columns, totals } = payload;
  const { header, body, totalRow } = toDisplayMatrix(payload);
  // Neutralise EVERY cell — a re-opened .xlsx evaluates a leading =,+,-,@ just
  // like a .csv (same guard as the registers exporter).
  const aoa = [];
  if (title) { aoa.push([neutralizeFormula(title)]); aoa.push([]); }
  aoa.push(header.map(neutralizeFormula));
  for (const r of body) aoa.push(r.map(neutralizeFormula));
  if (totalRow) aoa.push(totalRow.map(neutralizeFormula));

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = (columns || []).map((c) => ({ wch: Math.max(8, Math.min(40, String(c.label || c.key).length + 4)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, String(title || 'Report').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return {
    fileName: `${payload.fileBase || slugify(title)}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: buf,
  };
}

// ── PDF (pdfkit, A4 landscape, wrapped header, page numbers) ─────────────────

const PDF_COLOR = {
  brand: '#1F3A5F',
  text: '#1A1A1A',
  muted: '#6B7280',
  zebra: '#F3F5F8',
  headerBg: '#E7ECF3',
};

function computeColWidths(columns, contentW) {
  const weights = (columns || []).map((c) => {
    const lab = String(c.label || c.key || '');
    if (/name|subject|description|note/i.test(lab)) return 2.6;
    if (c.type === 'money' || c.type === 'number') return 1.3;
    if (c.type === 'date') return 1.4;
    return Math.max(1, Math.min(2.4, lab.length / 6));
  });
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w) => Math.max(20, (w / sum) * contentW));
}

function buildPdf(payload) {
  return new Promise((resolve, reject) => {
    try {
      // pdfkit is an existing backend dep (payslips, Form-16, registers).
      // eslint-disable-next-line global-require
      const PDFDocument = require('pdfkit');
      const { title, columns, totals } = payload;
      const { body, totalRow } = toDisplayMatrix(payload);
      const cols = Array.isArray(columns) ? columns : [];

      const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margin: 28,
        bufferPages: true, // needed to stamp "Page N of M" at the end
        info: { Title: String(title || 'Report'), Author: 'DriftHR', Subject: 'Report export', Creator: 'DriftHR' },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('error', reject);
      doc.on('end', () => resolve({
        fileName: `${payload.fileBase || slugify(title)}.pdf`,
        contentType: 'application/pdf',
        content: Buffer.concat(chunks),
      }));

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const bottom = doc.page.height - doc.page.margins.bottom;
      const contentW = right - left;
      const colWidths = computeColWidths(cols, contentW);
      const tableW = colWidths.reduce((a, b) => a + b, 0);
      const headerH = 22;
      const rowH = 13;

      const alignFor = (c) => c.align || ((c.type === 'money' || c.type === 'number') ? 'right' : 'left');

      function drawHeaderRow(y) {
        doc.save();
        doc.rect(left, y, tableW, headerH).fill(PDF_COLOR.headerBg);
        doc.restore();
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(PDF_COLOR.brand);
        let x = left;
        for (let i = 0; i < cols.length; i++) {
          doc.text(String(cols[i].label || cols[i].key), x + 2, y + 3, {
            width: colWidths[i] - 4,
            align: alignFor(cols[i]),
            lineBreak: true, // wrapped header labels
            height: headerH - 2,
            ellipsis: false,
          });
          x += colWidths[i];
        }
        return y + headerH;
      }

      // Title block.
      doc.fillColor(PDF_COLOR.brand).font('Helvetica-Bold').fontSize(13)
        .text(String(title || 'Report'), left, doc.y, { width: contentW });
      if (payload.subtitle) {
        doc.font('Helvetica').fontSize(8.5).fillColor(PDF_COLOR.muted)
          .text(String(payload.subtitle), left, doc.y + 1, { width: contentW });
      }
      doc.moveDown(0.5);

      let y = drawHeaderRow(doc.y);
      doc.font('Helvetica').fontSize(6.5).fillColor(PDF_COLOR.text);

      let zebra = false;
      for (const r of body) {
        if (y + rowH > bottom - 16) {
          doc.addPage();
          y = drawHeaderRow(doc.page.margins.top);
          doc.font('Helvetica').fontSize(6.5).fillColor(PDF_COLOR.text);
          zebra = false;
        }
        if (zebra) {
          doc.save();
          doc.rect(left, y, tableW, rowH).fill(PDF_COLOR.zebra);
          doc.restore();
          doc.fillColor(PDF_COLOR.text);
        }
        zebra = !zebra;
        let x = left;
        for (let i = 0; i < cols.length; i++) {
          doc.text(r[i], x + 2, y + 3, {
            width: colWidths[i] - 4,
            align: alignFor(cols[i]),
            lineBreak: false,
            ellipsis: true,
            height: rowH,
          });
          x += colWidths[i];
        }
        y += rowH;
      }

      if (totalRow) {
        if (y + rowH > bottom - 16) { doc.addPage(); y = doc.page.margins.top; }
        doc.save();
        doc.rect(left, y, tableW, rowH).fill(PDF_COLOR.headerBg);
        doc.restore();
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(PDF_COLOR.brand);
        let x = left;
        for (let i = 0; i < cols.length; i++) {
          doc.text(totalRow[i], x + 2, y + 3, { width: colWidths[i] - 4, align: alignFor(cols[i]), lineBreak: false });
          x += colWidths[i];
        }
      }

      // Page numbers + generation stamp on every buffered page.
      const range = doc.bufferedPageRange();
      const stamp = `Generated ${(payload.generatedAt || new Date().toISOString())} · DriftHR`;
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.font('Helvetica').fontSize(6).fillColor(PDF_COLOR.muted);
        doc.text(stamp, left, bottom - 8, { width: contentW / 2, align: 'left', lineBreak: false });
        doc.text(`Page ${i - range.start + 1} of ${range.count}`, left + contentW / 2, bottom - 8, {
          width: contentW / 2, align: 'right', lineBreak: false,
        });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/**
 * exportTabular(format, payload, opts) → Promise<{ fileName, contentType, content }>.
 * @param {string} format  'CSV' | 'XLSX' | 'PDF' (case-insensitive)
 * @param {object} payload { title, columns:[{key,label,type?}], rows, totals?, fileBase?, subtitle?, generatedAt? }
 */
async function exportTabular(format, payload, opts = {}) {
  const f = String(format || 'CSV').toUpperCase();
  if (f === 'CSV') return buildCsv(payload);
  if (f === 'XLSX') return buildXlsx(payload, opts);
  if (f === 'PDF') return buildPdf(payload);
  const e = new Error(`Unsupported export format "${format}" (allowed: ${FORMATS.join(', ')})`);
  e.statusCode = 400;
  e.code = 'BAD_FORMAT';
  throw e;
}

module.exports = {
  exportTabular,
  buildCsv,
  buildXlsx,
  buildPdf,
  formatCell,
  csvCell,
  neutralizeFormula,
  slugify,
  FORMATS,
};
