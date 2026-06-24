'use strict';

/**
 * form12bbPdf.js — Feature 20 slice 20e. Form 12BB (Rule 26C(1)) — the statutory
 * "statement showing particulars of claims by an employee for deduction of tax u/s
 * 192". Built from the VERIFIED record: declared vs HR-verified per claim, plus the
 * HRA landlord particulars (Rule 26C) and the §24(b) lender row. A sibling of
 * taxProjectionPdf.js — same pdfkit setup, palette, and money/fmtDate helpers. PURE:
 * the controller resolves the data; this turns it into a Buffer.
 *
 *   renderForm12bbPdf({ form, business }) -> Promise<Buffer>
 *
 * `form` shape (built by the controller from proofs + StatutoryProfile):
 *   { employeeName, employeeCode, pan, financialYear, regime,
 *     hra: { rentPaid, verified, landlordName, landlordPan, monthsCovered } | null,
 *     homeLoan: { declared, verified, lenderName?, lenderPan? } | null,
 *     chapterVIA: [{ section, label, declared, verified }],
 *     basis: 'DECLARED' | 'VERIFIED' }
 */

const PDFDocument = require('pdfkit');

const CURRENCY = { INR: { symbol: '₹', locale: 'en-IN' } };

function money(amount, currencyCode = 'INR') {
  const cc = String(currencyCode || 'INR').toUpperCase();
  const meta = CURRENCY[cc] || { symbol: cc ? cc + ' ' : '', locale: 'en-IN' };
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${meta.symbol}0.00`;
  const grouped = Math.abs(n).toLocaleString(meta.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${meta.symbol}${grouped}`;
}

function businessName(business) {
  const b = business || {};
  return b.name || b.legalName || b.displayName || 'Company';
}

function fmtDate(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  try {
    const dt = d instanceof Date ? d : new Date(d);
    return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
  } catch (_e) { return ''; }
}

const PAGE = { size: 'A4', margin: 40 };
const COLOR = {
  brand: '#1F3A5F', accent: '#2E6F95', text: '#1A1A1A',
  muted: '#6B7280', line: '#D1D5DB', zebra: '#F3F5F8',
};

function kvRow(doc, { left, contentW, label, value, bold }) {
  const y = doc.y;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(COLOR.text);
  doc.text(label, left, y, { width: contentW * 0.55 });
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
  doc.text(value, left + contentW * 0.55, y, { width: contentW * 0.45, align: 'right' });
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

// A 3-column claim table: label · declared · verified. Used for Chapter VI-A.
function claimTable(doc, { left, contentW, rows, cc }) {
  const c0 = left, c1 = left + contentW * 0.56, c2 = left + contentW * 0.78;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.muted);
  const hy = doc.y;
  doc.text('Particulars', c0, hy, { width: contentW * 0.56 });
  doc.text('Declared', c1, hy, { width: contentW * 0.22, align: 'right' });
  doc.text('Verified', c2, hy, { width: contentW * 0.22, align: 'right' });
  doc.moveDown(0.3);
  let zebra = false;
  for (const r of rows) {
    ensureSpace(doc, 16);
    const ry = doc.y;
    if (zebra) doc.rect(left, ry - 1.5, contentW, 13).fill(COLOR.zebra);
    zebra = !zebra;
    doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.text);
    doc.text(r.label, c0, ry, { width: contentW * 0.56 });
    doc.text(money(r.declared, cc), c1, ry, { width: contentW * 0.22, align: 'right' });
    doc.text(money(r.verified, cc), c2, ry, { width: contentW * 0.22, align: 'right' });
    doc.moveDown(0.25);
  }
}

function renderForm12bbPdf({ form, business } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const f = form || {};
      const cc = 'INR';
      const doc = new PDFDocument({
        size: PAGE.size,
        margin: PAGE.margin,
        info: {
          Title: `Form 12BB ${f.financialYear || ''}`.trim(),
          Author: businessName(business),
          Subject: 'Form 12BB — particulars of claims u/s 192',
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

      // Header band.
      doc.rect(left, doc.y, contentW, 54).fill(COLOR.brand);
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(15);
      doc.text('FORM 12BB', left + 14, doc.page.margins.top + 9, { width: contentW - 28 });
      doc.font('Helvetica').fontSize(8.5);
      doc.text('Statement of particulars of claims for deduction of tax u/s 192 (Rule 26C)', left + 14, doc.page.margins.top + 30, { width: contentW - 28 });
      doc.y = doc.page.margins.top + 64;
      doc.fillColor(COLOR.text);

      // Employee details.
      sectionTitle(doc, { left, contentW, title: '1. Employee details' });
      kvRow(doc, { left, contentW, label: 'Name of the employee', value: f.employeeName || f.employeeCode || '—', bold: true });
      kvRow(doc, { left, contentW, label: 'Employee code', value: f.employeeCode || '—' });
      kvRow(doc, { left, contentW, label: 'PAN of the employee', value: f.pan || '—' });
      kvRow(doc, { left, contentW, label: 'Financial year', value: f.financialYear || '—' });
      kvRow(doc, { left, contentW, label: 'Tax regime', value: `${f.regime || 'OLD'} regime` });

      if (f.regime !== 'OLD') {
        doc.moveDown(0.6);
        doc.font('Helvetica').fontSize(9).fillColor(COLOR.muted);
        doc.text('Under the new tax regime, deductions under Chapter VI-A and the HRA exemption do not apply. No proof particulars are required.', left, doc.y, { width: contentW });
        doc.end();
        return;
      }

      // 1. House Rent Allowance (Rule 26C(2) — landlord PAN if rent > ₹1,00,000).
      sectionTitle(doc, { left, contentW, title: '2. House Rent Allowance (HRA)' });
      if (f.hra) {
        kvRow(doc, { left, contentW, label: 'Rent paid to the landlord (annual)', value: money(f.hra.rentPaid, cc) });
        kvRow(doc, { left, contentW, label: 'Verified rent (HR)', value: money(f.hra.verified, cc), bold: true });
        kvRow(doc, { left, contentW, label: 'Name of the landlord', value: f.hra.landlordName || '—' });
        kvRow(doc, { left, contentW, label: 'PAN of the landlord', value: f.hra.landlordPan || '— (not required ≤ ₹1,00,000)' });
        if (f.hra.monthsCovered != null) kvRow(doc, { left, contentW, label: 'Months covered by receipts', value: String(f.hra.monthsCovered) });
      } else {
        doc.font('Helvetica').fontSize(9).fillColor(COLOR.muted);
        doc.text('No HRA exemption claimed.', left, doc.y, { width: contentW });
        doc.moveDown(0.3);
      }

      // 3. Interest on borrowing — §24(b) home loan.
      sectionTitle(doc, { left, contentW, title: '3. Deduction of interest on borrowing (§24(b))' });
      if (f.homeLoan) {
        kvRow(doc, { left, contentW, label: 'Interest payable / paid (declared)', value: money(f.homeLoan.declared, cc) });
        kvRow(doc, { left, contentW, label: 'Verified interest (HR)', value: money(f.homeLoan.verified, cc), bold: true });
        kvRow(doc, { left, contentW, label: 'Name of the lender', value: f.homeLoan.lenderName || '—' });
        kvRow(doc, { left, contentW, label: 'PAN of the lender', value: f.homeLoan.lenderPan || '—' });
      } else {
        doc.font('Helvetica').fontSize(9).fillColor(COLOR.muted);
        doc.text('No home-loan interest claimed.', left, doc.y, { width: contentW });
        doc.moveDown(0.3);
      }

      // 4. Chapter VI-A deductions.
      sectionTitle(doc, { left, contentW, title: '4. Deduction under Chapter VI-A' });
      const chap = Array.isArray(f.chapterVIA) ? f.chapterVIA : [];
      if (chap.length) {
        claimTable(doc, { left, contentW, rows: chap, cc });
      } else {
        doc.font('Helvetica').fontSize(9).fillColor(COLOR.muted);
        doc.text('No Chapter VI-A deductions claimed.', left, doc.y, { width: contentW });
        doc.moveDown(0.3);
      }

      // Basis note + verification footer.
      doc.moveDown(0.6);
      ensureSpace(doc, 70);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.accent);
      const basisNote = f.basis === 'VERIFIED'
        ? 'TDS basis: VERIFIED — the proof deadline has passed; only HR-verified amounts reduce TDS.'
        : 'TDS basis: DECLARED (provisional) — before the proof deadline; declared figures are used until proofs are verified.';
      doc.text(basisNote, left, doc.y, { width: contentW });
      doc.moveDown(0.6);
      doc.font('Helvetica').fontSize(8).fillColor(COLOR.muted);
      doc.text('Verification: I certify that the above particulars are true and the evidence has been furnished to the employer. Generated by DriftHR from the verified investment-proof record.', left, doc.y, { width: contentW });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { renderForm12bbPdf, _internals: { money, fmtDate } };
