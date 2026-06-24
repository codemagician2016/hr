'use strict';

/**
 * taxProjectionPdf.js — Feature 15. Branded, downloadable PDF of the India
 * income-tax PROJECTION (the Figma "IT computation" statement). A sibling of
 * payslipPdf.js reusing the same pdfkit setup, the same `money`/`fmtDate`
 * helpers, and the same brand palette/layout. PURE: no DB, no network — the
 * controller resolves the secured statement (from the assembler) + the tenant
 * identity, and this module turns it into a Buffer.
 *
 *   renderTaxProjectionPdf({ statement, business }) -> Promise<Buffer>
 *
 * `statement` is the assembler's output (§5.1) — all amounts are MAJOR-unit
 * rupee NUMBERS; we only group them for display, never re-derive.
 *
 * Robustness: never throws on a minimal statement — every accessor is defensive.
 */

const PDFDocument = require('pdfkit');

const CURRENCY = {
  INR: { symbol: '₹', locale: 'en-IN' },
};

function money(amount, currencyCode = 'INR') {
  const cc = String(currencyCode || 'INR').toUpperCase();
  const meta = CURRENCY[cc] || { symbol: cc ? cc + ' ' : '', locale: 'en-IN' };
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${meta.symbol}0.00`;
  const neg = n < 0;
  const grouped = Math.abs(n).toLocaleString(meta.locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${neg ? '-' : ''}${meta.symbol}${grouped}`;
}

function businessName(business) {
  const b = business || {};
  return b.name || b.legalName || b.displayName || b.tradingName || 'Company';
}

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

const PAGE = { size: 'A4', margin: 40 };
const COLOR = {
  brand: '#1F3A5F',
  accent: '#2E6F95',
  text: '#1A1A1A',
  muted: '#6B7280',
  line: '#D1D5DB',
  zebra: '#F3F5F8',
  netBg: '#1F3A5F',
};

// Render a single label/value row, returns the new y.
function kvRow(doc, { left, contentW, label, value, bold, muted, indent = 0 }) {
  const y = doc.y;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
  doc.fillColor(muted ? COLOR.muted : COLOR.text);
  doc.text(label, left + indent, y, { width: contentW * 0.62 - indent, continued: false });
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
  doc.fillColor(muted ? COLOR.muted : COLOR.text);
  doc.text(value, left + contentW * 0.62, y, { width: contentW * 0.38, align: 'right' });
  doc.moveDown(0.35);
  return doc.y;
}

function sectionTitle(doc, { left, contentW, title }) {
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(COLOR.brand);
  doc.text(title, left, doc.y, { width: contentW });
  const y = doc.y + 2;
  doc.moveTo(left, y).lineTo(left + contentW, y).strokeColor(COLOR.line).lineWidth(0.6).stroke();
  doc.moveDown(0.4);
}

function ensureSpace(doc, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) doc.addPage();
}

/**
 * renderTaxProjectionPdf — build the IT-computation PDF and resolve a Buffer.
 *
 * @param {{ statement: Object, business?: Object }} args
 * @returns {Promise<Buffer>}
 */
function renderTaxProjectionPdf({ statement, business } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const s = statement || {};
      const cc = s.currencyCode || 'INR';

      const doc = new PDFDocument({
        size: PAGE.size,
        margin: PAGE.margin,
        info: {
          Title: `Income-tax projection ${s.taxYear || ''}`.trim(),
          Author: businessName(business),
          Subject: 'Income-tax projection',
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

      // ── Header band ──
      doc.rect(left, doc.y, contentW, 54).fill(COLOR.brand);
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(15);
      doc.text(businessName(business), left + 14, doc.page.margins.top + 10, { width: contentW - 28 });
      doc.font('Helvetica').fontSize(9.5);
      doc.text('Income-tax projection (TDS computation)', left + 14, doc.page.margins.top + 30, { width: contentW - 28 });
      doc.y = doc.page.margins.top + 64;
      doc.fillColor(COLOR.text);

      // ── Employee + FY/regime strip ──
      doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR.text);
      doc.text(s.employeeName || s.employeeCode || 'Employee', left, doc.y, { width: contentW * 0.6, continued: false });
      const fyLabel = `FY ${s.taxYear || ''} · ${String(s.regime || 'NEW')} regime`;
      const yStrip = doc.y - 13;
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLOR.accent);
      doc.text(fyLabel, left + contentW * 0.6, yStrip < doc.page.margins.top ? doc.y : yStrip, { width: contentW * 0.4, align: 'right' });
      doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.muted);
      doc.text(`Code: ${s.employeeCode || '—'}   ·   As of ${fmtDate(s.asOf)}`, left, doc.y, { width: contentW });
      doc.moveDown(0.2);

      // ── Earnings ──
      sectionTitle(doc, { left, contentW, title: 'Gross salary breakup' });
      const e = s.annualEarnings || {};
      kvRow(doc, { left, contentW, label: 'Basic + DA', value: money(e.basicDa, cc) });
      kvRow(doc, { left, contentW, label: 'House Rent Allowance (HRA)', value: money(e.hra, cc) });
      kvRow(doc, { left, contentW, label: 'Other allowances', value: money(e.otherAllowances, cc) });
      kvRow(doc, { left, contentW, label: 'Residual / choice pay', value: money(e.residualChoicePay, cc) });
      kvRow(doc, { left, contentW, label: 'Gross salary', value: money(e.grossSalary, cc), bold: true });

      // ── HRA exemption (OLD only) ──
      if (s.hraExemption) {
        sectionTitle(doc, { left, contentW, title: 'HRA exemption (§10(13A))' });
        const legs = s.hraExemption.legs || {};
        kvRow(doc, { left, contentW, label: 'HRA received', value: money(legs.received, cc), muted: true });
        kvRow(doc, { left, contentW, label: 'Rent paid − 10% of salary', value: money(legs.rentMinus10, cc), muted: true });
        kvRow(doc, { left, contentW, label: '50%/40% of salary', value: money(legs.pctOfSalary, cc), muted: true });
        kvRow(doc, { left, contentW, label: 'Exemption (least of three)', value: money(s.hraExemption.exempt, cc), bold: true });
        kvRow(doc, { left, contentW, label: 'Gross earning after exemption', value: money(s.grossEarningAfterExemption, cc), bold: true });
      } else {
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(COLOR.muted);
        doc.moveDown(0.2);
        doc.text('NEW regime — exemptions and Chapter VI-A deductions do not apply.', left, doc.y, { width: contentW });
        doc.fillColor(COLOR.text);
      }

      // ── Perquisites ──
      if (s.perquisites && Array.isArray(s.perquisites.lines) && s.perquisites.lines.length) {
        ensureSpace(doc, 60);
        sectionTitle(doc, { left, contentW, title: 'Value of perquisites' });
        for (const p of s.perquisites.lines) {
          kvRow(doc, { left, contentW, label: p.label || p.kind || 'Perquisite', value: money(p.amount, cc) });
          if (p.explain) {
            doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(COLOR.muted);
            doc.text(p.explain, left + 10, doc.y, { width: contentW - 10 });
            doc.moveDown(0.2);
            doc.fillColor(COLOR.text);
          }
        }
        kvRow(doc, { left, contentW, label: 'Total perquisites', value: money(s.perquisites.total, cc), bold: true });
      }

      // ── Chapter VI-A (OLD only) — gross / qualifying / deductible table ──
      if (s.chapterVIA && Array.isArray(s.chapterVIA.lines) && s.chapterVIA.lines.length) {
        ensureSpace(doc, 80);
        sectionTitle(doc, { left, contentW, title: 'Deductions under Chapter VI-A' });
        // Column header.
        const c0 = left;
        const c1 = left + contentW * 0.40;
        const c2 = left + contentW * 0.62;
        const c3 = left + contentW * 0.81;
        doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.muted);
        const hy = doc.y;
        doc.text('Section', c0, hy, { width: contentW * 0.40 });
        doc.text('Gross', c1, hy, { width: contentW * 0.22, align: 'right' });
        doc.text('Qualifying', c2, hy, { width: contentW * 0.19, align: 'right' });
        doc.text('Deductible', c3, hy, { width: contentW * 0.19, align: 'right' });
        doc.moveDown(0.5);
        doc.fillColor(COLOR.text).font('Helvetica').fontSize(8.5);
        let zebra = false;
        for (const l of s.chapterVIA.lines) {
          const ry = doc.y;
          if (zebra) doc.rect(left, ry - 1.5, contentW, 13).fill(COLOR.zebra).fillColor(COLOR.text);
          zebra = !zebra;
          doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.text);
          doc.text(`${l.section}`, c0, ry, { width: contentW * 0.18 });
          doc.font('Helvetica').fontSize(7.2).fillColor(COLOR.muted);
          doc.text(`${l.label || ''}`, c0 + contentW * 0.18, ry + 0.5, { width: contentW * 0.22 });
          doc.fontSize(8.5).fillColor(COLOR.text);
          doc.text(money(l.gross, cc), c1, ry, { width: contentW * 0.22, align: 'right' });
          doc.text(money(l.qualifying, cc), c2, ry, { width: contentW * 0.19, align: 'right' });
          doc.font('Helvetica-Bold').text(money(l.deductible, cc), c3, ry, { width: contentW * 0.19, align: 'right' });
          doc.font('Helvetica');
          doc.moveDown(0.5);
        }
        kvRow(doc, { left, contentW, label: 'Maximum qualifying amount', value: money(s.chapterVIA.maxQualifying, cc), muted: true });
        kvRow(doc, { left, contentW, label: 'Total deductible (Chapter VI-A)', value: money(s.chapterVIA.totalDeductible, cc), bold: true });
      }

      // ── Standard deduction + taxable income ──
      ensureSpace(doc, 70);
      sectionTitle(doc, { left, contentW, title: 'Taxable income' });
      kvRow(doc, { left, contentW, label: 'Standard deduction', value: money(s.standardDeduction, cc) });
      if (s.previousEmployerCounted) {
        kvRow(doc, { left, contentW, label: 'Add: previous-employer income', value: money(s.previousEmployerTaxableIncome || 0, cc), muted: true });
      }
      kvRow(doc, { left, contentW, label: 'Total taxable income', value: money(s.totalTaxableIncome, cc), bold: true });

      // ── Tax computation ──
      ensureSpace(doc, 70);
      sectionTitle(doc, { left, contentW, title: 'Tax payable' });
      kvRow(doc, { left, contentW, label: 'Tax payable (before surcharge/cess)', value: money(s.taxPayable, cc) });
      kvRow(doc, { left, contentW, label: 'Surcharge', value: money(s.surcharge, cc) });
      kvRow(doc, { left, contentW, label: 'Health & Education cess (4%)', value: money(s.cess, cc) });
      kvRow(doc, { left, contentW, label: 'Total tax', value: money(s.totalTax, cc), bold: true });
      if (s.noPanApplied) {
        doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(COLOR.muted);
        doc.text('No PAN on record — tax applied at 20% flat (§206AA).', left, doc.y, { width: contentW });
        doc.moveDown(0.2); doc.fillColor(COLOR.text);
      }

      // ── TDS this year + previous employer ──
      sectionTitle(doc, { left, contentW, title: 'Tax already accounted' });
      kvRow(doc, { left, contentW, label: 'Tax deducted this year (your payslips)', value: money(s.tdsDeductedThisFY, cc) });
      kvRow(doc, { left, contentW, label: 'Tax deducted by previous employer', value: money(s.previousEmployerTds, cc) });
      kvRow(doc, { left, contentW, label: 'Balance tax remaining', value: money(s.remainingTax, cc), bold: true });

      // ── Monthly tax recoverable (highlight) ──
      ensureSpace(doc, 56);
      doc.moveDown(0.3);
      const boxY = doc.y;
      doc.rect(left, boxY, contentW, 40).fill(COLOR.netBg);
      doc.fillColor('#FFFFFF').font('Helvetica').fontSize(9);
      doc.text('Monthly tax recoverable', left + 12, boxY + 8, { width: contentW - 24 });
      doc.font('Helvetica-Bold').fontSize(15);
      doc.text(
        `${money(s.monthlyRecoverable, cc)} / month`,
        left + 12, boxY + 19, { width: contentW - 24 },
      );
      doc.font('Helvetica').fontSize(8).fillColor('#FFFFFF');
      doc.text(
        `over your remaining ${s.monthsRemaining || 0} month(s)`,
        left + contentW - 200, boxY + 24, { width: 188, align: 'right' },
      );
      doc.y = boxY + 48;
      doc.fillColor(COLOR.text);

      // ── 80C investments table ──
      if (Array.isArray(s.investments80C) && s.investments80C.length) {
        ensureSpace(doc, 60);
        sectionTitle(doc, { left, contentW, title: '80C investments' });
        for (const inv of s.investments80C) {
          const tag = inv.source === 'DERIVED' ? '(from payslips)' : '(declared)';
          kvRow(doc, { left, contentW, label: `${inv.label || inv.code}  ${tag}`, value: money(inv.amount, cc) });
        }
      }

      // ── Regime comparison line ──
      if (s.regimeComparison) {
        ensureSpace(doc, 30);
        doc.moveDown(0.3);
        const rc = s.regimeComparison;
        doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.muted);
        doc.text(
          `Under ${rc.alternativeRegime} regime your total tax would be ${money(rc.alternativeTotalTax, cc)} — ` +
          `you're better off on ${rc.betterRegime}.`,
          left, doc.y, { width: contentW },
        );
        doc.fillColor(COLOR.text);
      }

      // ── Footer disclaimer ──
      const footY = doc.page.height - doc.page.margins.bottom - 16;
      doc.font('Helvetica-Oblique').fontSize(7).fillColor(COLOR.muted);
      doc.text(
        'Projected from your current salary and declaration — this is NOT a Form 16. Final tax is computed at year-end.',
        left, footY, { width: contentW, align: 'center' },
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderTaxProjectionPdf, _internals: { money, fmtDate, businessName } };
