'use strict';

/**
 * renderLetter.js — PURE pdf-lib overlay of a merged letter body onto an
 * uploaded A4 letterhead PDF. No DB, no routes, no network: the caller supplies
 * the letterhead bytes, the normalized layout, the already-merged body text, the
 * resolved field strings, the bundled Unicode TTF bytes, and (optionally) a
 * signature PNG. This module draws + flattens and resolves to a Buffer.
 *
 *   renderLetter({ letterheadPdf, layout, bodyText, fields, signaturePng,
 *                  fontBytes, fontBoldBytes, opts }) -> Promise<Buffer>
 *
 * Two gotchas baked in (see docs/features/09-letters-communication.md §4.1):
 *   1. pdf-lib's origin is BOTTOM-LEFT. We store rects normalized top-left
 *      (0..1). Convert at render against the REAL page.getSize() — never assume
 *      595×842 — and honour page.getRotation() so a rotated/off-A4 letterhead
 *      still lands correctly.
 *   2. The 14 StandardFonts are WinAnsi/Latin-1 only — drawing ₹ (U+20B9) or any
 *      non-Latin glyph THROWS. We MUST embed a bundled Unicode TTF via
 *      registerFontkit + embedFont(...,{subset:true}). Noto Sans is bundled in
 *      letters/fonts/ (₹-safe).
 *
 * Body overflow: pdf-lib has no auto-wrap/auto-pagination — we own it. Greedy
 * word-wrap with font.widthOfTextAtSize to the writing-area width, advance y by
 * (fontSize + lineGap); when the cursor crosses the writing-area bottom, start a
 * new page per opts.overflowPolicy:
 *   - 'repeat-letterhead'  copy the original letterhead page (branded on every
 *                          page — the correct default), or
 *   - 'blank-continuation' a plain page the same size as page 1 (body only).
 */

const { PDFDocument, rgb, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

// ── normalized-layout defaults ───────────────────────────────────────────────
// All rects are { x, y, w, h } in [0,1], origin TOP-LEFT (the visual-picker
// convention). Sensible fallbacks so a partial / missing layout never throws.
//
// DEFAULT_WRITING_AREA is the "admin uploaded a letterhead but never opened the
// position-picker" case — we MUST still render the body cleanly inside the
// stationery's writing area rather than scattering it over the header/footer.
// These are conventional A4 business-letter body margins, expressed normalized so
// they hold for any page size the engine reads at render:
//   - x 0.10 / w 0.80  → ~20mm L/R gutters on A4 (210mm wide).
//   - y 0.26           → top edge sits BELOW a typical letterhead header band
//                        (logo + address strip occupy the top ~25%).
//   - h 0.56           → bottom edge (0.26+0.56 = 0.82) stays ABOVE a typical
//                        footer band (statutory strip lives in the bottom ~18%).
// The result is a clean, wrapped single column of body text that never collides
// with the printed stationery.
const DEFAULT_WRITING_AREA = {
  x: 0.1, y: 0.26, w: 0.8, h: 0.56, align: 'left', fontSize: 11, lineGap: 4,
};
const DEFAULT_FIELD_SIZE = 10;

/**
 * @param {Object}   args
 * @param {Buffer}   args.letterheadPdf  bytes of the uploaded A4 letterhead PDF
 * @param {Object}   args.layout         CompanyLetterhead.layoutJson (normalized, top-left origin)
 * @param {string}   args.bodyText       fully merged letter body (fields already resolved)
 * @param {Object}  [args.fields]        { date, refNo, authority, subject } resolved strings
 * @param {Buffer}  [args.signaturePng]  optional authority signature PNG (drawn in fields.signature box)
 * @param {Buffer}   args.fontBytes      bundled Unicode TTF (₹/non-Latin safe)
 * @param {Buffer}  [args.fontBoldBytes] bundled bold TTF (refNo/subject/authority emphasis)
 * @param {Object}  [args.opts]          { overflowPolicy, signatureOnLastPage, watermark }
 * @returns {Promise<Buffer>}            flattened PDF
 */
async function renderLetter({
  letterheadPdf,
  layout,
  bodyText,
  fields,
  signaturePng,
  fontBytes,
  fontBoldBytes,
  opts,
} = {}) {
  if (!letterheadPdf || !(letterheadPdf instanceof Uint8Array || Buffer.isBuffer(letterheadPdf))) {
    throw new Error('renderLetter: letterheadPdf (Buffer) is required');
  }
  if (!fontBytes) {
    throw new Error('renderLetter: fontBytes (Unicode TTF) is required — StandardFonts cannot render ₹');
  }

  const lay = layout && typeof layout === 'object' ? layout : {};
  const writingArea = { ...DEFAULT_WRITING_AREA, ...(lay.writingArea || {}) };
  const fieldRects = lay.fields && typeof lay.fields === 'object' ? lay.fields : {};
  const f = fields && typeof fields === 'object' ? fields : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  const overflowPolicy = o.overflowPolicy === 'blank-continuation'
    ? 'blank-continuation'
    : 'repeat-letterhead';
  const signatureOnLastPage = !!o.signatureOnLastPage;

  // ── load + fontkit + embed fonts ───────────────────────────────────────────
  const lhBytes = toUint8(letterheadPdf);
  const doc = await PDFDocument.load(lhBytes);
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(toUint8(fontBytes), { subset: true });
  const fontBold = fontBoldBytes
    ? await doc.embedFont(toUint8(fontBoldBytes), { subset: true })
    : font;

  // Page 0 is the letterhead underlay we draw the body onto. For
  // 'repeat-letterhead' continuations we need a CLEAN copy of the stationery
  // (not page 0 after we've drawn body text on it), so we keep a pristine
  // template document loaded from the same original bytes and copy page 0 from
  // it on demand.
  let templateDoc = null;
  async function pristineLetterheadPage() {
    if (!templateDoc) templateDoc = await PDFDocument.load(lhBytes);
    const [copied] = await doc.copyPages(templateDoc, [0]);
    return doc.addPage(copied);
  }

  const page0 = doc.getPage(0);

  // ── helper: geometry for a page, honouring rotation + MediaBox origin ──────
  // page.getSize() returns the UN-rotated media box DIMENSIONS only — it discards
  // the MediaBox lower-left ORIGIN. Real-world letterheads exported from design
  // tools (Canva/InDesign/Word) frequently carry a non-zero MediaBox origin (e.g.
  // [50 30 645 872] instead of [0 0 595 842]). The letterhead's OWN printed
  // content is laid out relative to that origin, but pdf-lib's drawText places our
  // body in absolute page space — so if we ignore the origin our body lands offset
  // by (−x0, −y0) and SCATTERS over the stationery (the reported bug). We therefore
  // read the real MediaBox and translate every drawn rect by (x0, y0).
  //
  // When a page is rotated 90°/270° its VISUAL width/height swap. We work in the
  // page's own (unrotated) coordinate space and let the viewer apply the rotation,
  // so the visible-area dimensions we wrap text to must account for that swap.
  function geom(page) {
    const { width: mw, height: mh } = page.getSize();
    const { x0, y0 } = mediaBoxOrigin(page);
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const swapped = rot === 90 || rot === 270;
    return {
      page,
      // MediaBox lower-left origin (absolute page-space offset to add to every draw).
      x0, y0,
      // visible (rotation-applied) dimensions used for normalized→absolute math
      visW: swapped ? mh : mw,
      visH: swapped ? mw : mh,
      rot,
    };
  }

  // Convert a normalized top-left rect → absolute bottom-left pdf-lib coords,
  // translated by the page's MediaBox lower-left origin (g.x0/g.y0) so a non-zero-
  // origin letterhead still lands the body inside the writing area.
  // absY_bottomLeft = y0 + visH − (yNorm·visH) − heightPt.   (Gotcha #1)
  function absRect(g, rect) {
    const xN = clamp01(num(rect.x, 0));
    const yN = clamp01(num(rect.y, 0));
    const wN = clamp01(num(rect.w, 0));
    const hN = clamp01(num(rect.h, 0));
    const wPt = wN * g.visW;
    const hPt = hN * g.visH;
    const xPt = g.x0 + xN * g.visW;
    const yTopPt = yN * g.visH;
    return {
      x: xPt,
      yTop: g.y0 + g.visH - yTopPt, // top edge in bottom-left origin
      yBottom: g.y0 + g.visH - yTopPt - hPt, // bottom edge in bottom-left origin
      w: wPt,
      h: hPt,
    };
  }

  // Draw a single line of text, defensively (drawText throws on unmappable
  // glyphs in standard fonts; with an embedded TTF subset every codepoint in the
  // bundle maps, but we still guard align + width).
  function drawLine(page, text, x, baselineY, size, useFont, align, maxW, color) {
    const t = String(text == null ? '' : text);
    if (!t) return;
    let drawX = x;
    if (align === 'right' || align === 'center') {
      const tw = safeWidth(useFont, t, size);
      if (align === 'right') drawX = x + Math.max(0, maxW - tw);
      else drawX = x + Math.max(0, (maxW - tw) / 2);
    }
    page.drawText(t, { x: drawX, y: baselineY, size, font: useFont, color: color || rgb(0.1, 0.1, 0.1) });
  }

  // ── 1) FIELD ANCHORS on page 1 (date / refNo / authority / subject) ────────
  const g0 = geom(page0);
  drawFieldAnchor(g0, fieldRects.date, f.date, font);
  drawFieldAnchor(g0, fieldRects.refNo, f.refNo, fontBold);
  drawFieldAnchor(g0, fieldRects.subject, f.subject, fontBold);
  drawFieldAnchor(g0, fieldRects.authority, f.authority, font);

  function drawFieldAnchor(g, rect, value, useFont) {
    if (!rect || value == null || value === '') return;
    const r = absRect(g, rect);
    const size = num(rect.fontSize, DEFAULT_FIELD_SIZE);
    const align = rect.align || 'left';
    // Anchor text on the rect's first-line baseline (top of rect, minus ascent).
    const baseline = r.yTop - size;
    drawLine(g.page, value, r.x, baseline, size, useFont, align, r.w);
  }

  // ── 2) WORD-WRAP + PAGINATE the body within the writing area ───────────────
  const size = num(writingArea.fontSize, 11);
  const lineGap = num(writingArea.lineGap, 4);
  const lineHeight = size + lineGap;
  const bodyAlign = writingArea.align || 'left';

  // writing-area absolute box on page 1
  let g = g0;
  let area = absRect(g, writingArea);
  let cursorY = area.yTop - size; // first baseline
  const bottomLimit = area.yBottom; // stop when next line would cross this

  // Greedy word-wrap one logical paragraph at a time; \n forces a break, blank
  // lines become vertical space.
  const lines = wrapBody(bodyText, font, size, area.w);

  const pages = [page0]; // track for signature-on-last-page

  // Add a continuation page per overflowPolicy: 'repeat-letterhead' re-stamps a
  // pristine letterhead; 'blank-continuation' adds a same-sized blank page.
  async function addContinuationPage() {
    let added;
    if (overflowPolicy === 'repeat-letterhead') {
      added = await pristineLetterheadPage();
    } else {
      const { width, height } = page0.getSize();
      added = doc.addPage([width, height]);
      added.setRotation(page0.getRotation());
      // Mirror page 1's MediaBox ORIGIN so the body lands in the same place on a
      // blank continuation as it does on the stationery (a non-zero-origin
      // letterhead must not shift the body between pages).
      const { x0, y0 } = mediaBoxOrigin(page0);
      if (x0 || y0) added.setMediaBox(x0, y0, width, height);
    }
    return added;
  }

  for (const line of lines) {
    // need room for this line's baseline; if it would dip below the area
    // bottom, paginate.
    if (cursorY < bottomLimit) {
      const added = await addContinuationPage();
      pages.push(added);
      g = geom(added);
      area = absRect(g, writingArea);
      cursorY = area.yTop - size;
    }
    if (line.text) {
      drawLine(g.page, line.text, area.x, cursorY, size, font, bodyAlign, area.w);
    }
    cursorY -= lineHeight;
  }

  // ── 3) WATERMARK (diagonal overlay across every page) ──────────────────────
  if (o.watermark) {
    const wmText = String(o.watermark);
    for (const p of doc.getPages()) {
      const gp = geom(p);
      const wmSize = Math.max(28, Math.floor(gp.visW / 9));
      const tw = safeWidth(fontBold, wmText, wmSize);
      p.drawText(wmText, {
        x: gp.x0 + (gp.visW - tw * 0.7) / 2,
        y: gp.y0 + gp.visH / 2,
        size: wmSize,
        font: fontBold,
        color: rgb(0.85, 0.1, 0.1),
        rotate: degrees(45),
        opacity: 0.18,
      });
    }
  }

  // ── 4) SIGNATURE PNG (in fields.signature box) ─────────────────────────────
  if (signaturePng && fieldRects.signature) {
    const sigBytes = toUint8(signaturePng);
    let sigPage = page0;
    let gp = g0;
    if (signatureOnLastPage) {
      sigPage = pages[pages.length - 1];
      gp = geom(sigPage);
    }
    try {
      const png = await doc.embedPng(sigBytes);
      const r = absRect(gp, fieldRects.signature);
      // fit the image inside the box preserving aspect ratio
      const dims = fitInside(png.width, png.height, r.w, r.h);
      sigPage.drawImage(png, {
        x: r.x + (r.w - dims.w) / 2,
        y: r.yBottom + (r.h - dims.h) / 2,
        width: dims.w,
        height: dims.h,
      });
    } catch (_e) {
      // A non-PNG / corrupt signature must not sink the whole letter.
    }
  }

  // ── flatten ────────────────────────────────────────────────────────────────
  const out = await doc.save();
  return Buffer.from(out);
}

// ── body wrapping ─────────────────────────────────────────────────────────────
// Returns an array of { text } lines. Honours explicit \n (paragraph breaks) and
// greedy-wraps each paragraph to maxWidth. A run of >maxWidth single token is
// hard-split so it can never loop forever.
function wrapBody(bodyText, font, size, maxWidth) {
  const out = [];
  const src = String(bodyText == null ? '' : bodyText);
  const paragraphs = src.split(/\r?\n/);
  for (const para of paragraphs) {
    if (para.trim() === '') {
      out.push({ text: '' }); // blank line = vertical gap
      continue;
    }
    const words = para.split(/\s+/).filter((w) => w.length > 0);
    let line = '';
    for (let word of words) {
      // hard-split a single word longer than the box
      while (safeWidth(font, word, size) > maxWidth && word.length > 1) {
        let cut = word.length;
        while (cut > 1 && safeWidth(font, word.slice(0, cut), size) > maxWidth) cut -= 1;
        const head = word.slice(0, cut);
        if (line) { out.push({ text: line }); line = ''; }
        out.push({ text: head });
        word = word.slice(cut);
      }
      const candidate = line ? `${line} ${word}` : word;
      if (safeWidth(font, candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) out.push({ text: line });
        line = word;
      }
    }
    if (line) out.push({ text: line });
  }
  return out;
}

// ── small utils ───────────────────────────────────────────────────────────────
// Read a page's MediaBox lower-left ORIGIN (x0, y0). pdf-lib's page.getSize()
// returns width/height only, so we go to the MediaBox dictionary entry. A page
// without an explicit MediaBox (inherited) or any read error defaults to (0, 0)
// — the legacy assumption, kept safe.
function mediaBoxOrigin(page) {
  try {
    const node = page && page.node;
    const mb = node && typeof node.MediaBox === 'function' ? node.MediaBox() : null;
    if (mb && typeof mb.asArray === 'function') {
      const arr = mb.asArray();
      const x0 = arr[0] && typeof arr[0].asNumber === 'function' ? arr[0].asNumber() : Number(arr[0]) || 0;
      const y0 = arr[1] && typeof arr[1].asNumber === 'function' ? arr[1].asNumber() : Number(arr[1]) || 0;
      return { x0: Number.isFinite(x0) ? x0 : 0, y0: Number.isFinite(y0) ? y0 : 0 };
    }
  } catch (_e) { /* fall through to origin */ }
  return { x0: 0, y0: 0 };
}
function toUint8(b) {
  if (b instanceof Uint8Array) return b;
  if (Buffer.isBuffer(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return new Uint8Array(b);
}
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function clamp01(n) {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
function safeWidth(font, text, size) {
  try {
    return font.widthOfTextAtSize(String(text), size);
  } catch (_e) {
    // Should not happen with an embedded subset, but never let metrics throw.
    return String(text).length * size * 0.5;
  }
}
function fitInside(w, h, maxW, maxH) {
  if (!(w > 0) || !(h > 0)) return { w: maxW, h: maxH };
  const scale = Math.min(maxW / w, maxH / h, 1);
  return { w: w * scale, h: h * scale };
}

module.exports = {
  renderLetter,
  _internals: { wrapBody },
};
