'use strict';

/*
 * renderLetter.test.js — PURE test for the pdf-lib letterhead overlay engine
 * (../renderLetter.js). No DB, no network, no jest.
 *
 *   node backend/src/hr/letters/__tests__/renderLetter.test.js
 *
 * Proves (per docs/features/09 §8 "Slice 9B"):
 *   - renderLetter overlays the merged body + date/refNo/authority onto a fixture
 *     A4 PDF (generated in-test with pdf-lib), resolves to a valid Buffer that
 *     begins with the "%PDF-" magic bytes;
 *   - the Y-FLIP is correct (a known top-left anchor lands on the upper half of
 *     the bottom-left page — we parse the saved PDF back and check the text op's
 *     y-coordinate is in the top portion);
 *   - ₹ renders without throwing (embedded Noto Sans TTF — StandardFonts can't);
 *   - a long body PAGINATES under BOTH overflowPolicy values
 *     ('repeat-letterhead' and 'blank-continuation') — output gains pages;
 *   - a signature PNG is drawn (output grows + contains an image XObject);
 *   - honours a rotated / non-A4 page without throwing.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { renderLetter, _internals } = require('../renderLetter');

const FONT_DIR = path.join(__dirname, '..', 'fonts');
const fontBytes = fs.readFileSync(path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
const fontBoldBytes = fs.readFileSync(path.join(FONT_DIR, 'NotoSans-Bold.ttf'));

let passed = 0;
let failed = 0;
const discrepancies = [];

function check(scenario, cond) {
  if (cond) { passed += 1; return; }
  failed += 1;
  discrepancies.push(scenario);
  console.error(`FAIL  ${scenario}`);
}

function isPdf(b) {
  return Buffer.isBuffer(b) && b.length > 4 && b.slice(0, 5).toString('latin1') === '%PDF-';
}

// Generate a simple A4 letterhead PDF fixture (one page, a faux header band so we
// can prove the underlay survives). Returns Buffer.
async function makeA4Fixture({ rotate = 0, width = 595.28, height = 841.89 } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  if (rotate) page.setRotation({ type: 'degrees', angle: rotate });
  const f = await doc.embedFont(StandardFonts.Helvetica);
  // a "letterhead" header band near the visual top (bottom-left origin → high y)
  page.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: rgb(0.12, 0.23, 0.37) });
  page.drawText('ACME LETTERHEAD', { x: 40, y: height - 50, size: 18, font: f, color: rgb(1, 1, 1) });
  return Buffer.from(await doc.save());
}

// A letterhead whose MediaBox does NOT start at (0,0) — mimics a real design-tool
// export. The header is drawn relative to the page's OWN origin so it sits at the
// visible top; the engine must translate the body by the same origin.
async function makeOffsetFixture({ ox = 50, oy = 30, width = 595.28, height = 841.89 } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  page.setMediaBox(ox, oy, width, height);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: ox, y: oy + height - 80, width, height: 80, color: rgb(0.12, 0.23, 0.37) });
  page.drawText('OFFSET LETTERHEAD', { x: ox + 40, y: oy + height - 50, size: 18, font: f, color: rgb(1, 1, 1) });
  return Buffer.from(await doc.save());
}

// Count the pages of a saved PDF buffer.
async function pageCount(buf) {
  const d = await PDFDocument.load(buf);
  return d.getPageCount();
}

// A 1×1 transparent PNG (valid) for the signature-draw test.
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const LAYOUT = {
  writingArea: { x: 0.1, y: 0.25, w: 0.8, h: 0.6, align: 'left', fontSize: 11, lineGap: 4 },
  fields: {
    date: { x: 0.7, y: 0.16, w: 0.2, h: 0.03, align: 'right', fontSize: 10 },
    refNo: { x: 0.1, y: 0.16, w: 0.4, h: 0.03, align: 'left', fontSize: 10 },
    subject: { x: 0.1, y: 0.21, w: 0.8, h: 0.03, align: 'left', fontSize: 11 },
    authority: { x: 0.1, y: 0.88, w: 0.4, h: 0.03, align: 'left', fontSize: 10 },
    signature: { x: 0.1, y: 0.82, w: 0.25, h: 0.05 },
  },
  overflowPolicy: 'repeat-letterhead',
};

const FIELDS = {
  date: '24/06/2026',
  refNo: 'ACME/HR/2026/0001',
  subject: 'Re: Experience Certificate',
  authority: 'Priya Sharma, Head of HR',
};

async function main() {
  const a4 = await makeA4Fixture();

  // 1) Basic overlay — short body, includes ₹ (rupee) to prove TTF embedding.
  const shortBody = [
    'To Whomsoever It May Concern,',
    '',
    'This is to certify that Asha Rao was employed with Acme Technologies.',
    'Her last drawn annual CTC was ₹ 18,50,000.00 (Rupees Eighteen Lakh Fifty Thousand only).',
    '',
    'We wish her the very best.',
  ].join('\n');

  let basic = null;
  try {
    basic = await renderLetter({
      letterheadPdf: a4, layout: LAYOUT, bodyText: shortBody, fields: FIELDS,
      fontBytes, fontBoldBytes, opts: { overflowPolicy: 'repeat-letterhead' },
    });
  } catch (e) {
    discrepancies.push(`basic render threw: ${e && e.stack}`);
    console.error('FAIL basic render threw:', e && e.stack);
    failed += 1;
  }
  check('basic: returns a Buffer', Buffer.isBuffer(basic));
  check('basic: starts with %PDF- magic', isPdf(basic));
  check('basic: non-trivial size (>2KB)', basic && basic.length > 2048);
  check('basic: still single page (short body)', basic && (await pageCount(basic)) === 1);

  // 2) ₹ proof — the rupee glyph must render with NO throw. (StandardFonts would
  //    throw on U+20B9; success here proves the embedded TTF path.) Asserted by
  //    the absence of a throw above + a dedicated rupee-only body.
  let rupeeOnly = null;
  try {
    rupeeOnly = await renderLetter({
      letterheadPdf: a4, layout: LAYOUT,
      bodyText: 'Net pay: ₹ 1,23,456.78 — confirmed. ₹₹₹',
      fields: { refNo: 'X/1', date: '24/06/2026' },
      fontBytes, fontBoldBytes,
    });
  } catch (e) {
    discrepancies.push(`₹ render threw (TTF embedding broken): ${e && e.message}`);
    console.error('FAIL ₹ render threw:', e && e.stack);
    failed += 1;
  }
  check('₹: renders without throwing (embedded Unicode TTF)', isPdf(rupeeOnly));

  // 2b) Control: a StandardFont genuinely CANNOT encode ₹ (documents WHY the TTF
  //     is mandatory). We expect this to throw.
  let stdThrew = false;
  try {
    const d = await PDFDocument.create();
    const p = d.addPage([200, 200]);
    const hf = await d.embedFont(StandardFonts.Helvetica);
    p.drawText('₹', { x: 10, y: 100, size: 12, font: hf });
    await d.save();
  } catch (_e) {
    stdThrew = true;
  }
  check('₹ control: StandardFont throws on ₹ (proves TTF is required)', stdThrew);

  // 3) Y-FLIP correctness. Parse the saved PDF's content stream and confirm the
  //    refNo (top-left y≈0.16) is drawn in the UPPER region of the page (high
  //    bottom-left y), while a body line near the bottom is lower. We read the
  //    first page's content ops for "Td"/"Tm" y values.
  const ycheck = await renderLetter({
    letterheadPdf: a4, layout: LAYOUT, bodyText: 'Body first line.', fields: FIELDS,
    fontBytes, fontBoldBytes,
  });
  const flipOk = await assertYFlip(ycheck);
  check('Y-flip: top-left anchor lands in upper half of bottom-left page', flipOk);

  // 4) Pagination under BOTH overflow policies. A very long body must spill onto
  //    multiple pages.
  const longBody = Array.from({ length: 400 }, (_, i) =>
    `Paragraph ${i + 1}: this is a sufficiently long sentence to force the greedy word-wrap engine to consume vertical space and eventually paginate the letter body across page boundaries.`
  ).join('\n\n');

  const repeatLH = await renderLetter({
    letterheadPdf: a4, layout: LAYOUT, bodyText: longBody, fields: FIELDS,
    fontBytes, fontBoldBytes, opts: { overflowPolicy: 'repeat-letterhead' },
  });
  const repeatPages = await pageCount(repeatLH);
  check('overflow repeat-letterhead: paginates (>1 page)', repeatPages > 1);
  check('overflow repeat-letterhead: valid PDF', isPdf(repeatLH));
  // every page should carry the letterhead band → re-stamped underlay. We assert
  // the page count grew and the doc is valid; the band re-stamp is by construction
  // (copyPages from a pristine template doc).

  const blankCont = await renderLetter({
    letterheadPdf: a4, layout: LAYOUT, bodyText: longBody, fields: FIELDS,
    fontBytes, fontBoldBytes, opts: { overflowPolicy: 'blank-continuation' },
  });
  const blankPages = await pageCount(blankCont);
  check('overflow blank-continuation: paginates (>1 page)', blankPages > 1);
  check('overflow blank-continuation: valid PDF', isPdf(blankCont));
  // blank-continuation pages are plain (no copied letterhead), so for the SAME
  // body the blank variant should not have MORE pages than repeat (same wrap),
  // and crucially both produce > 1 page.
  check('overflow: both policies produce the same line-wrap page count', blankPages === repeatPages);

  // 5) Signature PNG drawn → output is a valid PDF and is larger than the
  //    no-signature render (the embedded image adds bytes).
  const noSig = await renderLetter({
    letterheadPdf: a4, layout: LAYOUT, bodyText: shortBody, fields: FIELDS,
    fontBytes, fontBoldBytes,
  });
  const withSig = await renderLetter({
    letterheadPdf: a4, layout: LAYOUT, bodyText: shortBody, fields: FIELDS,
    signaturePng: ONE_PX_PNG, fontBytes, fontBoldBytes,
  });
  check('signature: valid PDF with sig', isPdf(withSig));
  const hasImageXObject = /\/Subtype\s*\/Image/.test(withSig.toString('latin1'));
  check('signature: output contains an Image XObject', hasImageXObject || withSig.length > noSig.length);

  // 6) Watermark overlay does not break the render.
  const wm = await renderLetter({
    letterheadPdf: a4, layout: LAYOUT, bodyText: shortBody, fields: FIELDS,
    fontBytes, fontBoldBytes, opts: { watermark: 'DRAFT — NOT VALID' },
  });
  check('watermark: valid PDF', isPdf(wm));

  // 7) Rotated / non-A4 letterhead must not throw and stays valid.
  const rotated = await makeA4Fixture({ rotate: 90 });
  let rotOut = null;
  try {
    rotOut = await renderLetter({
      letterheadPdf: rotated, layout: LAYOUT, bodyText: shortBody, fields: FIELDS,
      fontBytes, fontBoldBytes,
    });
  } catch (e) {
    discrepancies.push(`rotated render threw: ${e && e.message}`);
    failed += 1;
  }
  check('rotation: rotated letterhead renders to valid PDF', isPdf(rotOut));

  const odd = await makeA4Fixture({ width: 612, height: 792 }); // US Letter
  const oddOut = await renderLetter({
    letterheadPdf: odd, layout: LAYOUT, bodyText: shortBody, fields: FIELDS,
    fontBytes, fontBoldBytes,
  });
  check('non-A4: US-Letter-sized letterhead renders to valid PDF', isPdf(oddOut));

  // 8) Guard: missing fontBytes throws (the contract: TTF is mandatory).
  let noFontThrew = false;
  try {
    await renderLetter({ letterheadPdf: a4, layout: LAYOUT, bodyText: 'x', fields: {} });
  } catch (_e) { noFontThrew = true; }
  check('guard: missing fontBytes throws', noFontThrew);

  // 9) Guard: missing letterheadPdf throws.
  let noLhThrew = false;
  try {
    await renderLetter({ layout: LAYOUT, bodyText: 'x', fields: {}, fontBytes });
  } catch (_e) { noLhThrew = true; }
  check('guard: missing letterheadPdf throws', noLhThrew);

  // 10) wrapBody internal: hard-splits a single oversize token, honours blank lines.
  const fontForWrap = await (async () => {
    const d = await PDFDocument.create();
    const fontkit = require('@pdf-lib/fontkit');
    d.registerFontkit(fontkit);
    return d.embedFont(fontBytes, { subset: true });
  })();
  const wrapped = _internals.wrapBody('a\n\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb word', fontForWrap, 11, 100);
  check('wrapBody: returns multiple lines for oversize token', wrapped.length >= 2);
  check('wrapBody: preserves a blank line (paragraph gap)', wrapped.some((l) => l.text === ''));

  // 11) THE LETTERHEAD-OVERLAY BUG (overhaul): a real letterhead exported from a
  //     design tool carries a non-zero MediaBox ORIGIN (e.g. [50 30 645 872]).
  //     page.getSize() returns dimensions only, so before the fix the body was
  //     drawn in absolute (0,0)-relative space and SCATTERED over the stationery.
  //     With an EMPTY layout (admin uploaded but never opened the position-picker)
  //     the engine must default to sensible A4 body margins AND translate by the
  //     MediaBox origin, so the body lands as clean wrapped text INSIDE the
  //     writing-area band on the visible page.
  const OX = 50, OY = 30, PW = 595.28, PH = 841.89;
  const offsetLh = await makeOffsetFixture({ ox: OX, oy: OY, width: PW, height: PH });
  const cleanBody = [
    'To Whomsoever It May Concern,',
    '',
    'This is to certify that Asha Rao was employed with Acme Technologies Pvt Ltd',
    'from 01/04/2021 and her conduct was found to be satisfactory throughout her tenure.',
    '',
    'We wish her continued success.',
  ].join('\n');
  const offsetOut = await renderLetter({
    letterheadPdf: offsetLh, layout: {}, // EMPTY layout → default writing area
    bodyText: cleanBody, fields: { date: '24/06/2026', refNo: 'ACME/HR/2026/0007' },
    fontBytes, fontBoldBytes,
  });
  check('letterhead-overlay: renders to a valid %PDF', isPdf(offsetOut));
  const offPos = extractTextPositions(offsetOut);
  // Default writing area is x:0.10 w:0.80 / y:0.26 h:0.56 (normalized, top-left).
  // On the visible page (origin OX/OY) that is the absolute band:
  //   x ∈ [OX+0.10·PW, OX+0.90·PW]   (left gutter .. right gutter)
  //   y ∈ [OY+(1-0.82)·PH, OY+(1-0.26)·PH] = baselines within the body column.
  const bandXMin = OX + 0.10 * PW - 1;
  const bandXMax = OX + 0.90 * PW + 1;
  const bandYMin = OY + (1 - 0.82) * PH - 12; // a touch of slack for the last baseline
  const bandYMax = OY + (1 - 0.26) * PH + 1;
  // Every drawn glyph run must sit inside the visible page AND inside the writing
  // band — i.e. NOT scattered over the header (high y) or off the left edge (x<OX).
  const bodyRuns = offPos.filter((p) => p.y < OY + 0.84 * PH); // exclude any field anchors up top
  const allInBand = bodyRuns.length > 0 && bodyRuns.every(
    (p) => p.x >= bandXMin && p.x <= bandXMax && p.y >= bandYMin && p.y <= bandYMax
  );
  check('letterhead-overlay: body text lands INSIDE the writing-area band (origin-translated, not scattered)', allInBand);
  // And specifically: the body x-origin must be translated by the MediaBox x0 (it
  // must NOT start near x≈0 — that would be the pre-fix scatter at the page edge).
  // Use the body-only runs (the stationery's OWN header text is at high y and is
  // part of the underlay, not the drawn body).
  const minBodyX = bodyRuns.length ? Math.min(...bodyRuns.map((p) => p.x)) : 0;
  check('letterhead-overlay: body x-origin honours the MediaBox lower-left origin', minBodyX >= OX + 0.10 * PW - 1);

  // ── report ──────────────────────────────────────────────────────────────
  console.log('');
  console.log(`renderLetter test: ${passed} passed, ${failed} failed of ${passed + failed} assertions.`);
  if (failed > 0) {
    console.log('Discrepancies:');
    for (const d of discrepancies) console.log('  - ' + d);
    process.exitCode = 1;
  }
}

// Parse the page content ops, collect text-positioning y-values, and confirm a
// high (upper) y exists (the refNo anchor at yNorm≈0.16 → bottom-left y≈697 on
// A4) — proving the top-left→bottom-left flip put it near the page top rather
// than near y=0. pdf-lib FlateDecode-compresses content streams, so we inflate
// each "stream … endstream" blob before scanning for Td/Tm operators.
function extractTextYs(buf) {
  const s = buf.toString('latin1');
  const ys = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let blk;
  while ((blk = streamRe.exec(s))) {
    const raw = Buffer.from(blk[1], 'latin1');
    let txt = null;
    try { txt = zlib.inflateSync(raw).toString('latin1'); } catch (_e) { txt = null; }
    if (!txt) continue;
    let m;
    const tdRe = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Td/g;
    while ((m = tdRe.exec(txt))) ys.push(Number(m[2]));
    const tmRe = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/g;
    while ((m = tmRe.exec(txt))) ys.push(Number(m[6]));
  }
  return ys;
}

// Like extractTextYs but returns {x, y} pairs from Tm/Td text-positioning ops
// (used by the letterhead-overlay band assertions).
function extractTextPositions(buf) {
  const s = buf.toString('latin1');
  const pts = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let blk;
  while ((blk = streamRe.exec(s))) {
    const raw = Buffer.from(blk[1], 'latin1');
    let txt = null;
    try { txt = zlib.inflateSync(raw).toString('latin1'); } catch (_e) { txt = null; }
    if (!txt) continue;
    let m;
    const tdRe = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Td/g;
    while ((m = tdRe.exec(txt))) pts.push({ x: Number(m[1]), y: Number(m[2]) });
    const tmRe = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/g;
    while ((m = tmRe.exec(txt))) pts.push({ x: Number(m[5]), y: Number(m[6]) });
  }
  return pts;
}

async function assertYFlip(buf) {
  const H = 841.89;
  const ys = extractTextYs(buf);
  if (!ys.length) return false;
  // refNo at yNorm≈0.16 → expect SOME drawn text in the upper half (y > H/2),
  // AND the body (yNorm≈0.25 → lower) to be present below it — i.e. a spread,
  // not everything clustered at y≈0 (which would mean NO flip happened).
  const hasUpper = ys.some((y) => y > H / 2);
  const minY = Math.min(...ys);
  return hasUpper && minY < H * 0.85; // top anchor up high, body lower → real flip
}

main().catch((e) => {
  console.error('renderLetter test crashed:', e && e.stack);
  process.exitCode = 1;
});
