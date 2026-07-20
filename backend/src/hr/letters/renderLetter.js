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
  stampPng,
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
  // Embed the FULL font, NOT a subset. Subsetted CID/Type0 fonts are the classic
  // cause of "text is in the PDF but renders as missing/scattered glyphs": many
  // viewers/rasterizers mishandle a subset's glyph table, so the text layer extracts
  // perfectly while the page renders blank. A legal document must render everywhere,
  // so we trade ~0.5-1 MB per letter for guaranteed fidelity.
  const font = await doc.embedFont(toUint8(fontBytes), { subset: false });
  const fontBold = fontBoldBytes
    ? await doc.embedFont(toUint8(fontBoldBytes), { subset: false })
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

  // Draw a COMPOSED line = a left-to-right sequence of { text, font, size } segments
  // in VISIBLE space, honouring the block alignment. Consecutive segments sharing a
  // font+size are coalesced into one drawText (correct spacing, fewer ops). This is
  // how the Markdown-subset body renders mixed regular/bold runs + heading sizes.
  function drawSegments(g, segments, xStart, baselineY, align, maxW) {
    const merged = [];
    for (const seg of segments || []) {
      if (!seg || !seg.text) continue;
      const last = merged[merged.length - 1];
      if (last && last.font === seg.font && last.size === seg.size) last.text += seg.text;
      else merged.push({ text: seg.text, font: seg.font, size: seg.size });
    }
    if (!merged.length) return;
    const total = merged.reduce((s, seg) => s + safeWidth(seg.font, seg.text, seg.size), 0);
    let drawX = xStart;
    if (align === 'right') drawX = xStart + Math.max(0, maxW - total);
    else if (align === 'center') drawX = xStart + Math.max(0, (maxW - total) / 2);
    for (const seg of merged) {
      const p = place(g, drawX, baselineY);
      g.page.drawText(seg.text, {
        x: p.x, y: p.y, size: seg.size, font: seg.font,
        color: rgb(0.1, 0.1, 0.1), rotate: degrees(p.angle),
      });
      drawX += safeWidth(seg.font, seg.text, seg.size);
    }
  }

  // ── 1) FIELD ANCHORS on page 1 (date / refNo / authority / subject) ────────
  const g0 = geom(page0);
  drawFieldAnchor(g0, fieldRects.date, f.date, font);
  drawFieldAnchor(g0, fieldRects.refNo, f.refNo, fontBold);
  drawFieldAnchor(g0, fieldRects.subject, f.subject, fontBold);
  drawSignatoryBlock(g0, fieldRects.authority, f.authority, f.authorityDesignation);

  function drawFieldAnchor(g, rect, value, useFont) {
    if (!rect || value == null || value === '') return;
    const r = absRect(g, rect);
    const size = num(rect.fontSize, DEFAULT_FIELD_SIZE);
    const align = rect.align || 'left';
    // Anchor text on the rect's first-line baseline (top of rect, minus ascent).
    const baseline = r.yTop - size;
    drawLine(g, value, r.x, baseline, size, useFont, align, r.w);
  }

  // The authority / signatory block: name + (optional) designation stacked under it,
  // anchored at the authority rect. Fed by buildRenderInputs' fields.authority +
  // fields.authorityDesignation (Phase 2 — real backing columns on the template).
  function drawSignatoryBlock(g, rect, name, designation) {
    if (!rect) return;
    const r = absRect(g, rect);
    const sz = num(rect.fontSize, DEFAULT_FIELD_SIZE);
    const align = rect.align || 'left';
    let baseline = r.yTop - sz;
    if (name) { drawLine(g, name, r.x, baseline, sz, font, align, r.w); baseline -= (sz + 3); }
    if (designation) drawLine(g, designation, r.x, baseline, Math.max(8, Math.round(sz * 0.9)), font, align, r.w);
  }

  // ── 2) WORD-WRAP + PAGINATE the body within the writing area ───────────────
  const size = num(writingArea.fontSize, 11);
  const lineGap = num(writingArea.lineGap, 4);
  const lineHeight = size + lineGap;
  const bodyAlign = writingArea.align || 'left';

  // writing-area absolute box on page 1.
  //
  // Guard against a DEGENERATE saved writing area: the position-picker lets an
  // operator shrink the box (resize floor h≈0.01 / w≈0.02), and a layout can also
  // arrive with a near-zero rect. If the resolved band is too short to hold even a
  // single wrapped line (h < one line-height) or too narrow to fit text, EVERY
  // line trips pagination and the whole body spills onto repeated letterhead pages
  // — leaving page 1 with the stationery but NO body (the reported "letterhead
  // shows but the content doesn't" bug). Fall back to the safe default band so the
  // body always lands on page 1. Continuation pages are all page-1-sized, so this
  // decision (made against page 1) holds for the whole letter.
  let effectiveWA = writingArea;
  {
    const probe = absRect(g0, writingArea);
    if (!(probe.h >= lineHeight) || !(probe.w >= size * 4)) {
      effectiveWA = { ...DEFAULT_WRITING_AREA, fontSize: size, lineGap, align: bodyAlign };
    }
  }
  let g = g0;
  let area = absRect(g, effectiveWA);
  let bottomLimit = area.yBottom; // paginate when the next line would cross this

  // Parse the body Markdown SUBSET (bold, H1/H2/H3, bullet + numbered lists) into
  // styled, wrapped lines. Each composed line carries its own segments (mixed
  // regular/bold runs) + size, so headings render larger and bold runs use the bold
  // TTF. A plain paragraph collapses to a single regular run, so an un-formatted
  // body renders exactly as before (backward compatible).
  const composed = composeLines(parseBlocks(bodyText), {
    font, fontBold, baseSize: size, lineGap, maxWidth: area.w,
  });

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

  // Descend a top cursor (y) by each composed line's OWN height, so headings
  // (taller lines) and body pack correctly; paginate before a line that won't fit.
  let y = area.yTop;
  for (const cl of composed) {
    const lineH = cl.size + lineGap;
    if (y - lineH < bottomLimit) {
      const added = await addContinuationPage();
      pages.push(added);
      g = geom(added);
      area = absRect(g, effectiveWA);
      bottomLimit = area.yBottom;
      y = area.yTop;
    }
    if (cl.segments && cl.segments.length) {
      // baseline ≈ top of the line minus the glyph ascent (~ the font size)
      drawSegments(g, cl.segments, area.x, y - cl.size, bodyAlign, area.w);
    }
    y -= lineH;
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
  // Feature 39 — the STAMP (company seal) draws exactly like the signature, in its
  // own box, so a template can carry both.
  for (const [imgBytes, rect] of [[signaturePng, fieldRects.signature], [stampPng, fieldRects.stamp]]) {
    if (!imgBytes || !rect) continue;
    const sigBytes = toUint8(imgBytes);
    let sigPage = page0;
    let gp = g0;
    if (signatureOnLastPage) {
      sigPage = pages[pages.length - 1];
      gp = geom(sigPage);
    }
    try {
      const png = await doc.embedPng(sigBytes);
      const r = absRect(gp, rect);
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

// ── Markdown SUBSET → styled, wrapped lines ─────────────────────────────────────
// The letter body is authored in a small Markdown subset (bold, H1/H2/H3, bullet +
// numbered lists). We parse it into blocks, then into wrapped "composed lines" of
// { text, font, size } segments the renderer draws. A plain paragraph collapses to
// a single regular run, so an un-formatted body renders identically to before.

const HEADING_SCALE = { h1: 1.6, h2: 1.35, h3: 1.15 };

// Split the body into blocks: #/##/### headings, "- "/"* " bullets, "N. " numbers,
// blank lines (vertical gap), else paragraph. Returns [{ type, text }].
function parseBlocks(md) {
  const src = String(md == null ? '' : md);
  const out = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*$/.test(line)) { out.push({ type: 'blank', text: '' }); continue; }
    let m;
    if ((m = /^\s*(#{1,3})\s+(.*)$/.exec(line))) out.push({ type: `h${m[1].length}`, text: m[2] });
    else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) out.push({ type: 'ul', text: m[1] });
    else if ((m = /^\s*(\d+)\.\s+(.*)$/.exec(line))) out.push({ type: 'ol', text: m[2] });
    else out.push({ type: 'p', text: line });
  }
  return out;
}

// Strip single * or _ emphasis markers around a run (italic is not slanted in v1 —
// no italic TTF is bundled — but markers must never survive as literal asterisks).
function stripEmphasis(t) {
  return String(t).replace(/(\*|_)(\S(?:[^*_]*\S)?)\1/g, '$2');
}

// Parse an inline Markdown SUBSET into styled runs. **bold** → bold run; single
// *emphasis* / _emphasis_ → markers stripped (plain); everything else literal.
// Returns [{ text, bold }].
function parseInline(text) {
  const s = String(text == null ? '' : text);
  const runs = [];
  const push = (t, bold) => { const v = stripEmphasis(t); if (v) runs.push({ text: v, bold: !!bold }); };
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0; let m;
  while ((m = re.exec(s))) { push(s.slice(last, m.index), false); push(m[1], true); last = re.lastIndex; }
  push(s.slice(last), false);
  return runs.length ? runs : [{ text: '', bold: false }];
}

// Turn blocks into drawable lines: { segments:[{text,font,size}], size }. `size`
// drives the line height + baseline. Blank blocks carry empty segments at base size.
function composeLines(blocks, ctx) {
  const { font, fontBold, baseSize, maxWidth } = ctx;
  const out = [];
  let olCount = 0;
  for (const b of blocks || []) {
    if (b.type === 'blank') { out.push({ segments: [], size: baseSize }); olCount = 0; continue; }
    const isHeading = b.type === 'h1' || b.type === 'h2' || b.type === 'h3';
    const size = isHeading ? Math.round(baseSize * HEADING_SCALE[b.type]) : baseSize;
    let runs = parseInline(b.text);
    if (b.type === 'ul') { runs = [{ text: '•  ', bold: false }, ...runs]; olCount = 0; }
    else if (b.type === 'ol') { olCount += 1; runs = [{ text: `${olCount}.  `, bold: false }, ...runs]; }
    else olCount = 0;
    // a little air before a heading that follows real content
    if (isHeading && out.length && out[out.length - 1].segments.length) {
      out.push({ segments: [], size: Math.max(4, Math.round(baseSize * 0.4)) });
    }
    for (const segLine of wrapRuns(runs, { font, fontBold, forceBold: isHeading, size, maxWidth })) {
      out.push({ segments: segLine, size });
    }
  }
  return out;
}

// Greedy word-wrap styled runs into lines of { text, font, size } segments. Honours
// per-run bold (or forceBold for headings). A single token wider than the box is
// hard-split so it can never loop forever.
function wrapRuns(runs, { font, fontBold, forceBold, size, maxWidth }) {
  const words = [];
  for (const r of runs) {
    const f = (forceBold || r.bold) ? fontBold : font;
    for (const part of String(r.text).split(/(\s+)/)) {
      if (part === '') continue;
      words.push({ text: part, font: f, size, isSpace: /^\s+$/.test(part) });
    }
  }
  const lines = [];
  let cur = []; let curW = 0;
  const trimTrailing = () => {
    while (cur.length && cur[cur.length - 1].isSpace) { curW -= safeWidth(cur[cur.length - 1].font, cur[cur.length - 1].text, size); cur.pop(); }
  };
  for (const w of words) {
    const ww = safeWidth(w.font, w.text, w.size);
    if (w.isSpace) { if (cur.length) { cur.push(w); curW += ww; } continue; }
    if (curW + ww > maxWidth && cur.length) { trimTrailing(); lines.push(cur); cur = []; curW = 0; }
    if (ww > maxWidth) {
      let word = w.text;
      while (safeWidth(w.font, word, size) > maxWidth && word.length > 1) {
        let cut = word.length;
        while (cut > 1 && safeWidth(w.font, word.slice(0, cut), size) > maxWidth) cut -= 1;
        if (cur.length) { lines.push(cur); cur = []; curW = 0; }
        lines.push([{ text: word.slice(0, cut), font: w.font, size }]);
        word = word.slice(cut);
      }
      if (word) { cur.push({ text: word, font: w.font, size, isSpace: false }); curW += safeWidth(w.font, word, size); }
      continue;
    }
    cur.push(w); curW += ww;
  }
  if (cur.length) { trimTrailing(); lines.push(cur); }
  return lines.length ? lines : [[]];
}

// ── body wrapping (legacy plain-text path, retained for the wrapBody unit test) ──
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
  _internals: { wrapBody, parseBlocks, parseInline, composeLines, wrapRuns },
};
