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

  // ── helper: geometry for a page, honouring rotation + the VISIBLE box ───────
  // Two coordinate spaces matter:
  //   • MEDIA space — the page's own (unrotated) coordinate system. pdf-lib's
  //     drawText/drawImage place content here. The MediaBox lower-left ORIGIN is
  //     frequently non-zero on real design-tool exports (e.g. [50 30 645 872]),
  //     and a CropBox often insets the visible page further (bleed trim). We read
  //     the VISIBLE box = CropBox ∩ MediaBox so the writing area maps onto what the
  //     reader actually sees, not the untrimmed media.
  //   • VISIBLE space — an upright page exactly as a human sees it: origin at the
  //     visible bottom-left, +x to the right, +y up, dimensions (visW × visH) with
  //     width/height SWAPPED for a 90°/270° /Rotate. Our normalized top-left layout
  //     rects live here.
  //
  // The page /Rotate is applied by the viewer to EVERYTHING on the page, our drawn
  // text included. So we must (a) lay out + wrap in visible space, then (b) map each
  // visible point back into media space AND draw the glyphs pre-rotated by −R, so
  // the viewer's +R rotation brings them upright. The previous engine drew text
  // axis-aligned in media space — on a rotated letterhead the viewer then spun the
  // body sideways/upside-down, overflowing the page and overlapping the stationery
  // (the reported "scrambled glyphs scattered over the letterhead" bug).
  function geom(page) {
    const { width: mw, height: mh } = page.getSize();
    const vb = visibleBox(page, mw, mh); // {bx, by, mw, mh} in MEDIA space
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const swapped = rot === 90 || rot === 270;
    return {
      page,
      // visible box lower-left origin + media dimensions (MEDIA space).
      bx: vb.bx, by: vb.by, mw: vb.mw, mh: vb.mh,
      // visible (rotation-applied) dimensions used for normalized→absolute math
      visW: swapped ? vb.mh : vb.mw,
      visH: swapped ? vb.mw : vb.mh,
      rot,
    };
  }

  // Map a VISIBLE-space point (vx from visible left, vy from visible bottom — both
  // in points, y-UP) to the MEDIA-space draw coordinates pdf-lib expects, plus the
  // text rotation (degrees) that keeps glyphs upright on the page the reader sees.
  // These four cases are calibrated against the viewer's applied /Rotate (verified
  // by round-tripping known points through pdf.js' viewport transform); the upright
  // text angle equals the page rotation R, and the coordinate map inverts R so a
  // 90°/180°/270° letterhead lands the body upright inside the visible writing area
  // instead of sideways/upside-down and overflowing (the scramble bug).
  //   mw/mh are the MEDIA (unrotated) width/height of the visible box.
  function place(g, vx, vy) {
    const { bx, by, mw, mh, rot } = g;
    switch (rot) {
      case 90:  return { x: bx + (mw - vy), y: by + vx,        angle: 90 };
      case 180: return { x: bx + (mw - vx), y: by + (mh - vy), angle: 180 };
      case 270: return { x: bx + vy,        y: by + (mh - vx), angle: 270 };
      default:  return { x: bx + vx,        y: by + vy,        angle: 0 };
    }
  }

  // Convert a normalized top-left rect → a rect in VISIBLE space (origin bottom-left
  // of the visible page, +y up). x/yBottom/yTop/w/h are all in visible points. The
  // caller turns these into media-space draws via place().
  function absRect(g, rect) {
    const xN = clamp01(num(rect.x, 0));
    const yN = clamp01(num(rect.y, 0));
    const wN = clamp01(num(rect.w, 0));
    const hN = clamp01(num(rect.h, 0));
    const wPt = wN * g.visW;
    const hPt = hN * g.visH;
    const xPt = xN * g.visW; // from visible left
    const yTopPt = g.visH - yN * g.visH; // top edge from visible bottom
    return {
      x: xPt,
      yTop: yTopPt, // top edge (visible, from bottom)
      yBottom: yTopPt - hPt, // bottom edge (visible, from bottom)
      w: wPt,
      h: hPt,
    };
  }

  // Draw a single line of text in VISIBLE space (x from visible left, baselineY from
  // visible bottom). We compute the alignment offset, map to media coords, and draw
  // the glyphs pre-rotated so they read upright on a rotated letterhead. Defensive:
  // drawText throws on unmappable glyphs in standard fonts; with an embedded TTF
  // subset every codepoint maps, but we still guard align + width.
  function drawLine(g, text, x, baselineY, size, useFont, align, maxW, color) {
    const t = String(text == null ? '' : text);
    if (!t) return;
    let drawX = x;
    if (align === 'right' || align === 'center') {
      const tw = safeWidth(useFont, t, size);
      if (align === 'right') drawX = x + Math.max(0, maxW - tw);
      else drawX = x + Math.max(0, (maxW - tw) / 2);
    }
    const p = place(g, drawX, baselineY);
    g.page.drawText(t, {
      x: p.x, y: p.y, size, font: useFont,
      color: color || rgb(0.1, 0.1, 0.1),
      rotate: degrees(p.angle),
    });
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
    drawLine(g, value, r.x, baseline, size, useFont, align, r.w);
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
      // Mirror page 1's MediaBox ORIGIN + CropBox so the body lands in the same
      // place on a blank continuation as it does on the stationery (a non-zero-
      // origin / cropped letterhead must not shift the body between pages).
      const { x0, y0 } = mediaBoxOrigin(page0);
      if (x0 || y0) added.setMediaBox(x0, y0, width, height);
      const crop = readBox(page0, 'CropBox');
      if (crop) added.setCropBox(crop.llx, crop.lly, crop.urx - crop.llx, crop.ury - crop.lly);
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
      drawLine(g, line.text, area.x, cursorY, size, font, bodyAlign, area.w);
    }
    cursorY -= lineHeight;
  }

  // ── 3) WATERMARK (diagonal overlay across every page) ──────────────────────
  // Anchored + rotated in VISIBLE space so it stays a centred 45° diagonal on the
  // page the reader sees, even when the letterhead is /Rotate'd. We combine the 45°
  // watermark tilt with the page rotation so the glyphs are not spun off-axis.
  if (o.watermark) {
    const wmText = String(o.watermark);
    for (const p of doc.getPages()) {
      const gp = geom(p);
      const wmSize = Math.max(28, Math.floor(gp.visW / 9));
      const tw = safeWidth(fontBold, wmText, wmSize);
      // start point in visible space: left of centre, on the vertical midline.
      const vx = (gp.visW - tw * 0.7) / 2;
      const vy = gp.visH / 2;
      const anchor = place(gp, vx, vy);
      p.drawText(wmText, {
        x: anchor.x,
        y: anchor.y,
        size: wmSize,
        font: fontBold,
        color: rgb(0.85, 0.1, 0.1),
        rotate: degrees((anchor.angle + 45) % 360),
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
      // image bottom-left corner in VISIBLE space (centred inside the box), mapped
      // to media coords; drawImage rotates about that corner, so the page-rotation
      // angle keeps the signature upright on a rotated letterhead.
      const vx = r.x + (r.w - dims.w) / 2;
      const vy = r.yBottom + (r.h - dims.h) / 2;
      const a = place(gp, vx, vy);
      sigPage.drawImage(png, {
        x: a.x,
        y: a.y,
        width: dims.w,
        height: dims.h,
        rotate: degrees(a.angle),
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
// Read a named page box ([llx lly urx ury]) from the page dict. pdf-lib's
// page.getSize() returns the MediaBox width/height only, so for the ORIGIN and for
// the CropBox we read the dictionary entries directly. Returns null when absent /
// unreadable so callers can fall back.
function readBox(page, name) {
  try {
    const node = page && page.node;
    const accessor = node && typeof node[name] === 'function' ? node[name]() : null;
    const mb = accessor && typeof accessor.asArray === 'function' ? accessor : null;
    if (!mb) return null;
    const arr = mb.asArray();
    const n = (v) => (v && typeof v.asNumber === 'function' ? v.asNumber() : Number(v));
    const llx = n(arr[0]); const lly = n(arr[1]); const urx = n(arr[2]); const ury = n(arr[3]);
    if (![llx, lly, urx, ury].every(Number.isFinite)) return null;
    return { llx: Math.min(llx, urx), lly: Math.min(lly, ury), urx: Math.max(llx, urx), ury: Math.max(lly, ury) };
  } catch (_e) { return null; }
}

// Read a page's MediaBox lower-left ORIGIN (x0, y0). A page without an explicit
// MediaBox (inherited) or any read error defaults to (0, 0) — kept safe.
function mediaBoxOrigin(page) {
  const mb = readBox(page, 'MediaBox');
  if (mb) return { x0: mb.llx, y0: mb.lly };
  return { x0: 0, y0: 0 };
}

// The VISIBLE box of a page in MEDIA coords: CropBox clipped to MediaBox when a
// CropBox is present (real exports inset a bleed-trim CropBox), else the MediaBox.
// Returns lower-left origin (bx, by) + dimensions (mw, mh). Falls back to the
// page.getSize() dimensions at origin (0,0) when boxes are unreadable.
function visibleBox(page, sizeW, sizeH) {
  const media = readBox(page, 'MediaBox') || { llx: 0, lly: 0, urx: sizeW, ury: sizeH };
  let box = media;
  const crop = readBox(page, 'CropBox');
  if (crop) {
    // intersect CropBox with MediaBox (PDF spec: CropBox is clipped to MediaBox)
    const llx = Math.max(crop.llx, media.llx);
    const lly = Math.max(crop.lly, media.lly);
    const urx = Math.min(crop.urx, media.urx);
    const ury = Math.min(crop.ury, media.ury);
    if (urx > llx && ury > lly) box = { llx, lly, urx, ury };
  }
  return { bx: box.llx, by: box.lly, mw: box.urx - box.llx, mh: box.ury - box.lly };
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
