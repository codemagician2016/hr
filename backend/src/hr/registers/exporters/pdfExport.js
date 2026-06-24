'use strict';

/*
 * pdfExport.js — A4-landscape PDF formatter for a projected register (Feature 32).
 *
 * Uses `pdfkit` (already a backend dep), the same path as payroll/payslipPdf.js +
 * tax/form16/form16Pdf.js. Registers are WIDE (muster has a per-day grid; wage has
 * many component columns) so the page is A4 LANDSCAPE. Renders a statutory title
 * block (form no. + Act + establishment + period + reg numbers), a paginated table
 * (header repeats per page, column widths proportional), a control-totals footer,
 * and a page footer with the generation timestamp.
 *
 * To render ₹ and ½ reliably we register the bundled NotoSans fonts the letters
 * module already ships (src/hr/letters/fonts) — falling back to Helvetica if they
 * are missing. Returns a Promise<{ fileName, contentType, content (Buffer) }>.
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(__dirname, '..', '..', 'letters', 'fonts');
const FONT_REG = path.join(FONT_DIR, 'NotoSans-Regular.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'NotoSans-Bold.ttf');

const COLOR = {
  brand: '#1F3A5F',
  text: '#1A1A1A',
  muted: '#6B7280',
  line: '#D1D5DB',
  zebra: '#F3F5F8',
  headerBg: '#E7ECF3',
};

function registerFonts(doc) {
  let reg = 'Helvetica';
  let bold = 'Helvetica-Bold';
  try {
    if (fs.existsSync(FONT_REG) && fs.existsSync(FONT_BOLD)) {
      doc.registerFont('Reg', FONT_REG);
      doc.registerFont('Bold', FONT_BOLD);
      reg = 'Reg';
      bold = 'Bold';
    }
  } catch (_e) { /* fall back to built-in Helvetica */ }
  return { reg, bold };
}

function titleBlock(doc, register, header, fonts, left, contentW) {
  const meta = register.meta || {};
  doc.fillColor(COLOR.brand).font(fonts.bold).fontSize(13)
    .text(meta.formLabel || 'Statutory Register', left, doc.y, { width: contentW });
  if (meta.actLabel) {
    doc.font(fonts.reg).fontSize(8.5).fillColor(COLOR.muted)
      .text(meta.actLabel, left, doc.y + 1, { width: contentW });
  }
  if (header) {
    const name = header.tradeName || header.legalName || '';
    const addr = [header.addressLine1, header.addressLine2, header.city, header.stateCode, header.postalCode].filter(Boolean).join(', ');
    const regs = [];
    if (header.pan) regs.push(`PAN ${header.pan}`);
    if (header.tan) regs.push(`TAN ${header.tan}`);
    doc.font(fonts.bold).fontSize(9).fillColor(COLOR.text).text(name, left, doc.y + 3, { width: contentW });
    if (addr) doc.font(fonts.reg).fontSize(8).fillColor(COLOR.muted).text(addr, left, doc.y + 1, { width: contentW });
    if (regs.length) doc.font(fonts.reg).fontSize(8).fillColor(COLOR.muted).text(regs.join('    '), left, doc.y + 1, { width: contentW });
  }
  if (meta.periodLabel) {
    doc.font(fonts.bold).fontSize(8.5).fillColor(COLOR.text)
      .text(`Period: ${meta.periodLabel}`, left, doc.y + 2, { width: contentW });
  }
  doc.moveDown(0.5);
}

function computeColWidths(columns, contentW) {
  // Weight: daily/short numeric cols narrow, name/address wide.
  const weights = columns.map((c) => {
    if (c.daily) return 0.6;
    const lab = String(c.label || '');
    if (/name|address|father/i.test(lab)) return 3.2;
    if (/designation|leave type/i.test(lab)) return 2.2;
    if (c.align === 'right') return 1.6;
    return Math.max(1, Math.min(2.5, lab.length / 6));
  });
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w) => Math.max(16, (w / sum) * contentW));
}

function drawHeaderRow(doc, columns, colWidths, fonts, left, y, rowH) {
  let x = left;
  doc.save();
  doc.rect(left, y, colWidths.reduce((a, b) => a + b, 0), rowH).fill(COLOR.headerBg);
  doc.restore();
  doc.font(fonts.bold).fontSize(6.5).fillColor(COLOR.brand);
  for (let i = 0; i < columns.length; i++) {
    doc.text(String(columns[i].label), x + 2, y + 3, {
      width: colWidths[i] - 4,
      align: columns[i].align || 'left',
      lineBreak: true,
      height: rowH - 2,
      ellipsis: false,
    });
    x += colWidths[i];
  }
  return y + rowH;
}

/**
 * buildPdf(register, opts) → Promise<{ fileName, contentType, content }>.
 * @param {object} register  projector output { columns, rows, totals, meta }
 * @param {object} [opts]    { header, fileBase, fileHash, generatedAt }
 */
function buildPdf(register, opts = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margin: 28,
        info: {
          Title: (register.meta && register.meta.formLabel) || 'Statutory Register',
          Author: (opts.header && (opts.header.tradeName || opts.header.legalName)) || 'DriftHR',
          Subject: 'Statutory Register',
          Creator: 'DriftHR',
        },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('error', reject);
      doc.on('end', () => resolve({
        fileName: `${opts.fileBase || `register_${(register.meta && register.meta.formCode) || 'export'}`}.pdf`,
        contentType: 'application/pdf',
        content: Buffer.concat(chunks),
      }));

      const fonts = registerFonts(doc);
      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const bottom = doc.page.height - doc.page.margins.bottom;
      const contentW = right - left;

      titleBlock(doc, register, opts.header, fonts, left, contentW);

      const columns = register.columns || [];
      const rows = register.rows || [];
      const totals = (register.totals && register.totals.byColumn) || {};
      const colWidths = computeColWidths(columns, contentW);
      const tableW = colWidths.reduce((a, b) => a + b, 0);
      const headerH = 20;
      const rowH = 13;

      let y = drawHeaderRow(doc, columns, colWidths, fonts, left, doc.y, headerH);
      doc.font(fonts.reg).fontSize(6.5).fillColor(COLOR.text);

      let zebra = false;
      for (const r of rows) {
        if (y + rowH > bottom - 16) {
          doc.addPage();
          y = doc.page.margins.top;
          y = drawHeaderRow(doc, columns, colWidths, fonts, left, y, headerH);
          doc.font(fonts.reg).fontSize(6.5).fillColor(COLOR.text);
          zebra = false;
        }
        if (zebra) {
          doc.save();
          doc.rect(left, y, tableW, rowH).fill(COLOR.zebra);
          doc.restore();
          doc.fillColor(COLOR.text);
        }
        zebra = !zebra;
        let x = left;
        const cells = r.cells || [];
        for (let i = 0; i < columns.length; i++) {
          const cell = cells[i];
          doc.text(cell && cell.text != null ? String(cell.text) : '', x + 2, y + 3, {
            width: colWidths[i] - 4,
            align: columns[i].align || 'left',
            lineBreak: false,
            ellipsis: true,
            height: rowH,
          });
          x += colWidths[i];
        }
        y += rowH;
      }

      // Control-totals footer row.
      const hasTotals = columns.some((c) => totals[c.key]);
      if (hasTotals) {
        if (y + rowH > bottom - 16) { doc.addPage(); y = doc.page.margins.top; }
        doc.save();
        doc.rect(left, y, tableW, rowH).fill(COLOR.headerBg);
        doc.restore();
        doc.font(fonts.bold).fontSize(6.5).fillColor(COLOR.brand);
        let x = left;
        for (let i = 0; i < columns.length; i++) {
          const txt = i === 0 ? 'TOTAL' : (totals[columns[i].key] ? totals[columns[i].key].display : '');
          doc.text(txt, x + 2, y + 3, { width: colWidths[i] - 4, align: columns[i].align || 'left', lineBreak: false });
          x += colWidths[i];
        }
        y += rowH;
      }

      // Page footer (generation stamp + hash) on the LAST page.
      const stamp = `Generated ${opts.generatedAt || new Date().toISOString()} · DriftHR`;
      const hashLine = opts.fileHash ? ` · SHA-256 ${String(opts.fileHash).slice(0, 16)}…` : '';
      doc.font(fonts.reg).fontSize(6).fillColor(COLOR.muted)
        .text(stamp + hashLine, left, bottom - 8, { width: contentW, align: 'left' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildPdf };
