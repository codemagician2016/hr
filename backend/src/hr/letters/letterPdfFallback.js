'use strict';

/**
 * letterPdfFallback.js — PURE pdfkit from-scratch branded letter for the
 * NO-letterhead case. No DB, no network: the caller hands in the business/brand
 * identity, the already-merged body text, and the resolved field strings; this
 * turns them into a flattened PDF Buffer.
 *
 *   renderLetterFallback({ business, brand, bodyText, fields, opts }) -> Promise<Buffer>
 *
 * Mirrors the patterns in ../payroll/payslipPdf.js: buffer-collection →
 * Promise<Buffer>, a branded header band, a footer, defensive accessors that
 * never throw on missing fields, and pdfkit's built-in word-wrap + pagination
 * (so unlike renderLetter we lean on doc.text's flow). A4 portrait.
 *
 * NOTE on ₹: pdfkit's BUILT-IN Helvetica is WinAnsi and cannot draw ₹. If the
 * caller passes `fontBytes` (the bundled Noto Sans TTF) we register + use it so
 * the fallback is also ₹-safe; otherwise we fall back to Helvetica (Latin only).
 */

const PDFDocument = require('pdfkit');

const PAGE = { size: 'A4', margin: 56 };
const COLOR = {
  brand: '#1F3A5F',
  accent: '#2E6F95',
  text: '#1A1A1A',
  muted: '#6B7280',
  line: '#D1D5DB',
  watermark: '#D9534F',
};

function businessName(business, brand) {
  const b = business || {};
  const br = brand || {};
  return (
    b.legalName || b.name || b.tradeName || b.tradingName ||
    br.tradeName || br.legalName || 'Company'
  );
}

function str(v) {
  return v == null ? '' : String(v);
}

/**
 * @param {Object}  args
 * @param {Object}  args.business  { legalName|name, addressBlock?, cin?, gstin?, nzbn? }
 * @param {Object} [args.brand]    TenantBrand-ish { logoPath?, primaryColor?, footerText?, tradeName? }
 * @param {string}  args.bodyText  fully merged body (fields already resolved)
 * @param {Object} [args.fields]   { date, refNo, authority, subject, addressee }
 * @param {Buffer} [args.fontBytes]     optional Unicode TTF (₹-safe)
 * @param {Buffer} [args.fontBoldBytes]
 * @param {Object} [args.opts]     { watermark }
 * @returns {Promise<Buffer>}
 */
function renderLetterFallback({ business, brand, bodyText, fields, signaturePng, fontBytes, fontBoldBytes, opts } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const b = business || {};
      const br = brand || {};
      const f = fields && typeof fields === 'object' ? fields : {};
      const o = opts && typeof opts === 'object' ? opts : {};
      const brandColor = isHexColor(br.primaryColor) ? br.primaryColor : COLOR.brand;

      const doc = new PDFDocument({
        size: PAGE.size,
        margin: PAGE.margin,
        info: {
          Title: `Letter ${str(f.refNo)}`.trim(),
          Author: businessName(b, br),
          Subject: str(f.subject) || 'Letter',
          Creator: 'DriftHR',
        },
      });

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      // ── register a Unicode TTF if provided (₹-safe), else Helvetica ─────────
      const REG = 'Body';
      const BOLD = 'BodyBold';
      let regFont = 'Helvetica';
      let boldFont = 'Helvetica-Bold';
      if (fontBytes) {
        try { doc.registerFont(REG, asBuf(fontBytes)); regFont = REG; } catch (_e) { /* keep Helvetica */ }
      }
      if (fontBoldBytes) {
        try { doc.registerFont(BOLD, asBuf(fontBoldBytes)); boldFont = BOLD; } catch (_e) { /* keep Helvetica-Bold */ }
      } else if (fontBytes && regFont === REG) {
        boldFont = REG; // reuse regular if no bold supplied
      }

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const contentW = right - left;

      // ── HEADER band ────────────────────────────────────────────────────────
      const top = doc.y;
      doc.save();
      doc.rect(left, top, contentW, 58).fill(brandColor);
      doc.restore();

      let textX = left + 16;
      const logoPath = br.logoPath || br.logoFile || b.logoPath;
      if (logoPath) {
        try { doc.image(logoPath, left + 14, top + 11, { fit: [36, 36] }); textX = left + 60; }
        catch (_e) { /* fall back to name text */ }
      }
      doc.fillColor('#FFFFFF').font(boldFont).fontSize(17)
        .text(businessName(b, br), textX, top + 12, { width: contentW - (textX - left) - 20, lineBreak: false, ellipsis: true });
      const addr = str(b.addressBlock || br.addressBlock);
      if (addr) {
        doc.font(regFont).fontSize(8).fillColor('#DCE5F0')
          .text(addr.replace(/\n+/g, ' · '), textX, top + 34, { width: contentW - (textX - left) - 20, lineBreak: false, ellipsis: true });
      }
      doc.fillColor(COLOR.text);
      doc.y = top + 58 + 18;

      // ── REF NO + DATE row ──────────────────────────────────────────────────
      const metaY = doc.y;
      if (f.refNo) {
        doc.font(boldFont).fontSize(9).fillColor(COLOR.muted)
          .text(`Ref: ${str(f.refNo)}`, left, metaY, { width: contentW * 0.6 });
      }
      if (f.date) {
        doc.font(regFont).fontSize(9).fillColor(COLOR.muted)
          .text(`Date: ${str(f.date)}`, left, metaY, { width: contentW, align: 'right' });
      }
      doc.y = metaY + 16;
      doc.fillColor(COLOR.text);

      // ── ADDRESSEE / SUBJECT ────────────────────────────────────────────────
      if (f.addressee) {
        doc.font(regFont).fontSize(10).fillColor(COLOR.text)
          .text(str(f.addressee), left, doc.y, { width: contentW });
        doc.moveDown(0.6);
      }
      if (f.subject) {
        doc.font(boldFont).fontSize(11).fillColor(COLOR.text)
          .text(str(f.subject), left, doc.y, { width: contentW });
        doc.moveDown(0.6);
      }

      // ── BODY (pdfkit owns wrap + pagination here) ──────────────────────────
      doc.font(regFont).fontSize(11).fillColor(COLOR.text)
        .text(str(bodyText), left, doc.y, {
          width: contentW,
          align: 'left',
          lineGap: 4,
          paragraphGap: 6,
        });
      doc.moveDown(2);

      // ── SIGNATURE IMAGE + AUTHORITY / SIGNATORY BLOCK ──────────────────────
      // The static signature (Phase 2) prints above the signatory name. The
      // letterhead path positions it absolutely from the layout; the flow-based
      // fallback stamps it inline just above the name (a signature line).
      if (signaturePng || f.authority) {
        ensureSpace(doc, 96);
        doc.moveDown(2);
        if (signaturePng) {
          try {
            const sigW = Math.min(160, contentW * 0.35);
            doc.image(asBuf(signaturePng), left, doc.y, { fit: [sigW, 54] });
            doc.y += 58;
          } catch (_e) { /* a bad/corrupt signature must never sink the letter */ }
        }
        if (f.authority) {
          doc.font(boldFont).fontSize(10).fillColor(COLOR.text)
            .text(str(f.authority), left, doc.y, { width: contentW * 0.6 });
          if (f.authorityDesignation) {
            doc.font(regFont).fontSize(9).fillColor(COLOR.muted)
              .text(str(f.authorityDesignation), left, doc.y, { width: contentW * 0.6 });
          }
          doc.font(regFont).fontSize(8).fillColor(COLOR.muted)
            .text(`For ${businessName(b, br)}`, left, doc.y, { width: contentW * 0.6 });
        }
      }

      // ── WATERMARK (diagonal, every page) ───────────────────────────────────
      if (o.watermark) {
        const wm = String(o.watermark);
        const range = doc.bufferedPageRange();
        for (let i = range.start; i < range.start + range.count; i += 1) {
          doc.switchToPage(i);
          drawWatermark(doc, wm, boldFont);
        }
      }

      // ── FOOTER on the (current) last page ──────────────────────────────────
      drawFooter(doc, { left, right, business: b, brand: br });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawWatermark(doc, text, fontName) {
  const cx = doc.page.width / 2;
  const cy = doc.page.height / 2;
  doc.save();
  doc.rotate(-45, { origin: [cx, cy] });
  doc.font(fontName).fontSize(64).fillColor(COLOR.watermark).fillOpacity(0.12)
    .text(text, cx - 260, cy - 32, { width: 520, align: 'center', lineBreak: false });
  doc.fillOpacity(1);
  doc.restore();
}

function drawFooter(doc, { left, right, business, brand }) {
  const y = doc.page.height - doc.page.margins.bottom + 8;
  doc.save();
  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(COLOR.line).stroke();
  doc.restore();
  const bits = [];
  const stat = [];
  if (business && business.cin) stat.push(`CIN: ${business.cin}`);
  if (business && business.gstin) stat.push(`GSTIN: ${business.gstin}`);
  if (business && business.nzbn) stat.push(`NZBN: ${business.nzbn}`);
  if (stat.length) bits.push(stat.join('  ·  '));
  if (brand && brand.footerText) bits.push(String(brand.footerText));
  const footer = bits.join('  ·  ') ||
    `Generated ${new Date().toISOString().slice(0, 10)} · DriftHR`;
  doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.muted)
    .text(footer, left, y + 5, { width: right - left, align: 'center', lineBreak: false, ellipsis: true });
  doc.fillColor(COLOR.text);
}

function ensureSpace(doc, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom - 24;
  if (doc.y + needed > bottom) doc.addPage();
}

function isHexColor(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}
function asBuf(b) {
  if (Buffer.isBuffer(b)) return b;
  if (b instanceof Uint8Array) return Buffer.from(b);
  return Buffer.from(b);
}

module.exports = { renderLetterFallback, _internals: { businessName, isHexColor } };
