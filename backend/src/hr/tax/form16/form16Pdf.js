'use strict';

/**
 * form16Pdf.js — Feature 24. Branded, downloadable PDF of a Form-16 TDS certificate
 * (Part A — quarter-wise TDS deposited summary + Part B — the annual tax annexure).
 * A sibling of taxProjectionPdf.js / payslipPdf.js reusing the same pdfkit setup,
 * the same money/fmtDate helpers and the same brand palette. PURE: no DB, no network
 * — the orchestrator resolves the frozen partA/partB JSON + the tenant identity, and
 * this module turns it into a Buffer (unit-testable).
 *
 *   renderForm16Pdf({ partA, partB, deductor, deductee, business, brand, signatory }) -> Promise<Buffer>
 *
 * partA/partB carry INTEGER PAISE (…Minor / amount fields are paise); we divide by
 * 100 for display, never re-derive. Robust: never throws on a minimal certificate.
 */

const PDFDocument = require('pdfkit');

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

// paise integer → "₹1,23,456.00" (en-IN grouping).
function money(minor) {
  const n = Number(minor);
  if (!Number.isFinite(n)) return '₹0.00';
  const rupees = n / 100;
  const neg = rupees < 0;
  const grouped = Math.abs(rupees).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${neg ? '-' : ''}₹${grouped}`;
}

function businessName(business) {
  const b = business || {};
  return b.name || b.legalName || b.displayName || b.tradingName || 'Company';
}

function fmtDate(d) {
  if (!d) return '—';
  if (typeof d === 'string') return d.slice(0, 10);
  try {
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return '—';
    return dt.toISOString().slice(0, 10);
  } catch (_e) { return '—'; }
}

// Indian numbering words for the amount-in-words line (whole rupees).
function amountInWords(minor) {
  const n = Math.round(Number(minor) / 100);
  if (!Number.isFinite(n) || n === 0) return 'Zero Rupees Only';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  function two(num) {
    if (num < 20) return ones[num];
    return `${tens[Math.floor(num / 10)]}${num % 10 ? ' ' + ones[num % 10] : ''}`;
  }
  function three(num) {
    const h = Math.floor(num / 100);
    const rest = num % 100;
    return `${h ? ones[h] + ' Hundred' + (rest ? ' ' : '') : ''}${rest ? two(rest) : ''}`;
  }
  let num = n;
  const parts = [];
  const crore = Math.floor(num / 10000000); num %= 10000000;
  const lakh = Math.floor(num / 100000); num %= 100000;
  const thousand = Math.floor(num / 1000); num %= 1000;
  const hundred = num;
  if (crore) parts.push(`${two(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (hundred) parts.push(three(hundred));
  return `${parts.join(' ').trim()} Rupees Only`;
}

function kvRow(doc, { left, contentW, label, value, bold, muted, indent = 0 }) {
  const y = doc.y;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(muted ? COLOR.muted : COLOR.text);
  doc.text(label, left + indent, y, { width: contentW * 0.62 - indent });
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(muted ? COLOR.muted : COLOR.text);
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

function headerBand(doc, { left, contentW, business, line1, line2 }) {
  doc.rect(left, doc.page.margins.top, contentW, 54).fill(COLOR.brand);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(14);
  doc.text(businessName(business), left + 14, doc.page.margins.top + 9, { width: contentW - 28 });
  doc.font('Helvetica').fontSize(9.5);
  doc.text(line1, left + 14, doc.page.margins.top + 28, { width: contentW - 28 });
  if (line2) { doc.fontSize(8); doc.text(line2, left + 14, doc.page.margins.top + 41, { width: contentW - 28 }); }
  doc.y = doc.page.margins.top + 64;
  doc.fillColor(COLOR.text);
}

/**
 * renderForm16Pdf — Part A (page 1) + Part B annexure (page 2+). Returns a Buffer.
 */
function renderForm16Pdf({ partA, partB, deductor, deductee, business, brand, signatory } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const A = partA || {};
      const B = partB || {};
      const ded = deductor || A.deductor || {};
      const dee = deductee || A.deductee || {};
      const sig = signatory || {};
      const formLabel = (B.regime === 'OLD' || B.regime === 'NEW') ? 'FORM NO. 16' : 'FORM NO. 16';

      const doc = new PDFDocument({
        size: PAGE.size,
        margin: PAGE.margin,
        info: {
          Title: `Form 16 ${A.financialYear || ''} — ${dee.name || ''}`.trim(),
          Author: businessName(business),
          Subject: 'Form 16 — Certificate under Section 203 of the Income-tax Act',
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

      // ── PAGE 1 — PART A ──
      headerBand(doc, {
        left, contentW, business,
        line1: `${formLabel} — Part A  ·  Certificate under Section 203 of the Income-tax Act, 1961`,
        line2: '[See rule 31(1)(a)]  ·  TDS certificate for tax deducted at source on salary',
      });

      doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR.accent);
      doc.text(`Certificate No: ${A.certificateNo || '—'}`, left, doc.y, { width: contentW });
      if (A.tracesCertNo) {
        doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.muted);
        doc.text(`TRACES authenticated number: ${A.tracesCertNo}`, left, doc.y, { width: contentW });
      }
      doc.fillColor(COLOR.text).moveDown(0.2);

      sectionTitle(doc, { left, contentW, title: 'Deductor (Employer)' });
      kvRow(doc, { left, contentW, label: 'Name', value: ded.name || businessName(business) });
      kvRow(doc, { left, contentW, label: 'PAN', value: ded.pan || '—' });
      kvRow(doc, { left, contentW, label: 'TAN', value: ded.tan || '—' });
      if (ded.address) kvRow(doc, { left, contentW, label: 'Address', value: ded.address, muted: true });

      sectionTitle(doc, { left, contentW, title: 'Deductee (Employee)' });
      kvRow(doc, { left, contentW, label: 'Name', value: dee.name || '—' });
      kvRow(doc, { left, contentW, label: 'PAN', value: dee.pan || 'NOT AVAILABLE' });
      kvRow(doc, { left, contentW, label: 'Employee code', value: dee.employeeCode || '—' });
      if (dee.address) kvRow(doc, { left, contentW, label: 'Address', value: dee.address, muted: true });

      sectionTitle(doc, { left, contentW, title: 'Period' });
      kvRow(doc, { left, contentW, label: 'Financial Year', value: A.financialYear || '—' });
      kvRow(doc, { left, contentW, label: 'Assessment Year', value: A.assessmentYear || '—' });
      const ep = A.employmentPeriod || {};
      kvRow(doc, { left, contentW, label: 'Period of employment', value: `${fmtDate(ep.from)}  to  ${fmtDate(ep.to)}` });

      // Quarter-wise TDS table.
      sectionTitle(doc, { left, contentW, title: 'Summary of tax deducted & deposited (quarter-wise)' });
      const c0 = left;
      const c1 = left + contentW * 0.16;
      const c2 = left + contentW * 0.44;
      const c3 = left + contentW * 0.72;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.muted);
      const hy = doc.y;
      doc.text('Quarter', c0, hy, { width: contentW * 0.16 });
      doc.text('Receipt / Challan', c1, hy, { width: contentW * 0.28 });
      doc.text('Deducted', c2, hy, { width: contentW * 0.28, align: 'right' });
      doc.text('Deposited', c3, hy, { width: contentW * 0.28, align: 'right' });
      doc.moveDown(0.5);
      doc.fillColor(COLOR.text);
      let zebra = false;
      for (const q of (A.quarters || [])) {
        ensureSpace(doc, 16);
        const ry = doc.y;
        if (zebra) { doc.rect(left, ry - 1.5, contentW, 13).fill(COLOR.zebra).fillColor(COLOR.text); }
        zebra = !zebra;
        const challanLabel = (q.challans && q.challans.length)
          ? q.challans.map((c) => c.challanRef || c.bsrCode || '').filter(Boolean).join(', ') || '—'
          : '—';
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLOR.text).text(q.quarter, c0, ry, { width: contentW * 0.16 });
        doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.muted).text(challanLabel, c1, ry, { width: contentW * 0.28 });
        doc.fontSize(8.5).fillColor(COLOR.text).text(money(q.tdsDeductedMinor), c2, ry, { width: contentW * 0.28, align: 'right' });
        doc.text(money(q.tdsDepositedMinor), c3, ry, { width: contentW * 0.28, align: 'right' });
        doc.moveDown(0.5);
      }
      doc.moveDown(0.2);
      kvRow(doc, { left, contentW, label: 'Total TDS deducted', value: money(A.totalTdsDeductedMinor), bold: true });
      kvRow(doc, { left, contentW, label: 'Total TDS deposited', value: money(A.totalTdsDepositedMinor), bold: true });
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(COLOR.muted);
      doc.text(`(Rupees ${amountInWords(A.totalTdsDepositedMinor)})`, left, doc.y, { width: contentW });
      doc.text(
        A.reconciledOk
          ? 'Tax deducted has been deposited and is reconciled against the available challan records.'
          : 'NOTE: one or more quarters show a deducted-vs-deposited gap — verify the challan deposits.',
        left, doc.y, { width: contentW },
      );
      doc.fillColor(COLOR.text);

      // ── PAGE 2+ — PART B (Annexure) ──
      doc.addPage();
      headerBand(doc, {
        left, contentW, business,
        line1: `${formLabel} — Part B (Annexure)  ·  Details of salary paid and tax`,
        line2: `${dee.name || ''}  ·  PAN ${dee.pan || 'NOT AVAILABLE'}  ·  FY ${A.financialYear || ''}  ·  ${String(B.regime || 'NEW')} regime`,
      });

      const g = B.grossSalary || {};
      sectionTitle(doc, { left, contentW, title: '1. Gross salary' });
      kvRow(doc, { left, contentW, label: '(a) Salary u/s 17(1)', value: money(g.section17_1) });
      kvRow(doc, { left, contentW, label: '(b) Perquisites u/s 17(2)', value: money(g.section17_2_perquisites) });
      kvRow(doc, { left, contentW, label: '(c) Profits in lieu u/s 17(3)', value: money(g.section17_3_profitsInLieu) });
      kvRow(doc, { left, contentW, label: 'Total', value: money(g.total), bold: true });

      sectionTitle(doc, { left, contentW, title: '2. Less: allowances exempt u/s 10' });
      const exempt = B.exemptAllowances_section10 || [];
      if (exempt.length) {
        for (const a of exempt) kvRow(doc, { left, contentW, label: `${a.type}`, value: money(a.amount), muted: true });
      } else {
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(COLOR.muted);
        doc.text('No exempt allowances (NEW regime — exemptions do not apply).', left, doc.y, { width: contentW });
        doc.fillColor(COLOR.text).moveDown(0.2);
      }
      kvRow(doc, { left, contentW, label: 'Net salary', value: money(B.netSalary), bold: true });

      sectionTitle(doc, { left, contentW, title: '3. Deductions u/s 16' });
      kvRow(doc, { left, contentW, label: '(ia) Standard deduction', value: money(B.standardDeduction_section16ia) });
      kvRow(doc, { left, contentW, label: '(iii) Professional tax', value: money(B.professionalTax_section16iii) });
      kvRow(doc, { left, contentW, label: 'Income chargeable under "Salaries"', value: money(B.incomeUnderHeadSalaries), bold: true });

      if (B.previousEmployerIncome) {
        kvRow(doc, { left, contentW, label: 'Add: income reported from previous employer', value: money(B.previousEmployerIncome), muted: true });
      }
      kvRow(doc, { left, contentW, label: 'Gross total income', value: money(B.grossTotalIncome), bold: true });

      // Chapter VI-A.
      const chap = B.chapterVIA || { lines: [], totalDeductible: 0 };
      if (chap.lines && chap.lines.length) {
        ensureSpace(doc, 70);
        sectionTitle(doc, { left, contentW, title: '4. Deductions under Chapter VI-A' });
        const k0 = left;
        const k1 = left + contentW * 0.50;
        const k2 = left + contentW * 0.75;
        doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.muted);
        const ky = doc.y;
        doc.text('Section', k0, ky, { width: contentW * 0.50 });
        doc.text('Gross', k1, ky, { width: contentW * 0.25, align: 'right' });
        doc.text('Deductible', k2, ky, { width: contentW * 0.25, align: 'right' });
        doc.moveDown(0.5);
        doc.fillColor(COLOR.text);
        for (const l of chap.lines) {
          ensureSpace(doc, 14);
          const ry = doc.y;
          doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.text).text(`${l.section}`, k0, ry, { width: contentW * 0.16 });
          doc.font('Helvetica').fontSize(7.2).fillColor(COLOR.muted).text(`${l.label || ''}`, k0 + contentW * 0.16, ry + 0.5, { width: contentW * 0.34 });
          doc.fontSize(8.5).fillColor(COLOR.text).text(money(l.grossAmount), k1, ry, { width: contentW * 0.25, align: 'right' });
          doc.font('Helvetica-Bold').text(money(l.deductibleAmount), k2, ry, { width: contentW * 0.25, align: 'right' });
          doc.font('Helvetica').moveDown(0.5);
        }
        kvRow(doc, { left, contentW, label: 'Total deductible under Chapter VI-A', value: money(chap.totalDeductible), bold: true });
      }

      ensureSpace(doc, 110);
      sectionTitle(doc, { left, contentW, title: '5. Tax on total income' });
      kvRow(doc, { left, contentW, label: 'Total income (rounded to nearest ₹10)', value: money(B.totalIncome), bold: true });
      kvRow(doc, { left, contentW, label: 'Tax on total income', value: money(B.taxOnTotalIncome) });
      kvRow(doc, { left, contentW, label: 'Less: rebate u/s 87A', value: money(B.rebate_section87A) });
      kvRow(doc, { left, contentW, label: 'Add: surcharge', value: money(B.surcharge) });
      kvRow(doc, { left, contentW, label: 'Add: Health & Education cess (4%)', value: money(B.healthAndEducationCess) });
      kvRow(doc, { left, contentW, label: 'Less: relief u/s 89', value: money(B.reliefs_section89) });

      ensureSpace(doc, 56);
      doc.moveDown(0.3);
      const boxY = doc.y;
      doc.rect(left, boxY, contentW, 40).fill(COLOR.netBg);
      doc.fillColor('#FFFFFF').font('Helvetica').fontSize(9);
      doc.text('Net tax payable', left + 12, boxY + 8, { width: contentW - 24 });
      doc.font('Helvetica-Bold').fontSize(15);
      doc.text(money(B.netTaxPayable), left + 12, boxY + 19, { width: contentW - 24 });
      doc.font('Helvetica').fontSize(8).fillColor('#FFFFFF');
      doc.text(`Total TDS: ${money(B.tdsDeducted)}`, left + contentW - 200, boxY + 24, { width: 188, align: 'right' });
      doc.y = boxY + 48;
      doc.fillColor(COLOR.text);

      if (B.noPanApplied) {
        doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(COLOR.muted);
        doc.text('No PAN on record — tax applied at 20% flat (§206AA).', left, doc.y, { width: contentW });
        doc.fillColor(COLOR.text).moveDown(0.2);
      }
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(COLOR.muted);
      doc.text(
        `Computed on the ${String(B.verifiedBasis || 'DECLARED')} declaration basis (${String(B.regime || 'NEW')} regime).`,
        left, doc.y, { width: contentW },
      );
      doc.fillColor(COLOR.text);

      // ── Verification block ──
      ensureSpace(doc, 80);
      sectionTitle(doc, { left, contentW, title: 'Verification' });
      const sName = sig.name || (brand && brand.signatoryName) || '_________________';
      const sDesig = sig.designation || (brand && brand.signatoryDesignation) || 'Authorised Signatory';
      doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.text);
      doc.text(
        `I, ${sName}, in capacity of ${sDesig}, do hereby certify that a sum as detailed above has been deducted at ` +
        'source and deposited to the credit of the Central Government. I further certify that the information given above ' +
        'is true, complete and correct and is based on the books of account, documents, TDS statements and other available records.',
        left, doc.y, { width: contentW },
      );
      doc.moveDown(1.2);
      doc.text(`Place: ${(ded.address || '').split(',').slice(-2, -1)[0] || '____________'}`, left, doc.y, { width: contentW * 0.5 });
      doc.moveUp(1);
      doc.text(`Signature: ${sName}`, left + contentW * 0.5, doc.y, { width: contentW * 0.5, align: 'right' });

      // ── Footer disclaimer ──
      const footY = doc.page.height - doc.page.margins.bottom - 16;
      doc.font('Helvetica-Oblique').fontSize(7).fillColor(COLOR.muted);
      doc.text(
        A.tracesCertNo
          ? 'Generated by DriftHR. This certificate carries a TRACES-authenticated number.'
          : 'Generated by DriftHR. Not a substitute for the TRACES-authenticated Part A unless a TRACES number is present.',
        left, footY, { width: contentW, align: 'center' },
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderForm16Pdf, _internals: { money, fmtDate, amountInWords, businessName } };
