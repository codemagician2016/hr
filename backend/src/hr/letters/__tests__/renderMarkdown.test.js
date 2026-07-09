'use strict';

/*
 * renderMarkdown.test.js — PURE test for the Markdown SUBSET the letter body
 * supports (Phase 1a): bold, H1/H2/H3 headings, bullet + numbered lists. Tests the
 * pure parsers (parseInline / parseBlocks / composeLines) directly and asserts the
 * rendered PDF actually draws a heading larger than the body + uses a second (bold)
 * font resource.
 *
 *   node backend/src/hr/letters/__tests__/renderMarkdown.test.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { renderLetter, _internals } = require('../renderLetter');
const { parseInline, parseBlocks, composeLines } = _internals;

const FONT_DIR = path.join(__dirname, '..', 'fonts');
const fontBytes = fs.readFileSync(path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
const fontBoldBytes = fs.readFileSync(path.join(FONT_DIR, 'NotoSans-Bold.ttf'));

let passed = 0; let failed = 0; const disc = [];
function check(name, cond) { if (cond) { passed += 1; return; } failed += 1; disc.push(name); console.error(`FAIL  ${name}`); }
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function isPdf(b) { return Buffer.isBuffer(b) && b.slice(0, 5).toString('latin1') === '%PDF-'; }

async function makeA4() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('LH', { x: 40, y: 790, size: 12, font: f });
  return Buffer.from(await doc.save());
}

// Decompress content streams and collect every `<name> <size> Tf` size + font name.
function extractTf(buf) {
  const s = buf.toString('latin1');
  const out = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let blk;
  while ((blk = streamRe.exec(s))) {
    let txt = null;
    try { txt = zlib.inflateSync(Buffer.from(blk[1], 'latin1')).toString('latin1'); } catch { txt = null; }
    if (!txt) continue;
    const tfRe = /\/([A-Za-z0-9_.+-]+)\s+(-?[\d.]+)\s+Tf/g;
    let m;
    while ((m = tfRe.exec(txt))) out.push({ name: m[1], size: Number(m[2]) });
  }
  return out;
}

async function main() {
  // ── parseInline ────────────────────────────────────────────────────────────
  check('inline: plain text is one regular run',
    eq(parseInline('Hello world'), [{ text: 'Hello world', bold: false }]));
  check('inline: **bold** splits into three runs',
    eq(parseInline('Hello **world** ok'),
      [{ text: 'Hello ', bold: false }, { text: 'world', bold: true }, { text: ' ok', bold: false }]));
  check('inline: leading bold has no empty prefix run',
    eq(parseInline('**bold** tail'), [{ text: 'bold', bold: true }, { text: ' tail', bold: false }]));
  check('inline: single *emphasis* markers are stripped (not literal)',
    eq(parseInline('a *em* b'), [{ text: 'a em b', bold: false }]));
  check('inline: _underscore_ emphasis markers are stripped',
    eq(parseInline('x _y_ z'), [{ text: 'x y z', bold: false }]));
  check('inline: empty string yields one empty run',
    eq(parseInline(''), [{ text: '', bold: false }]));

  // ── parseBlocks ──────────────────────────────────────────────────────────────
  const blocks = parseBlocks('# Title\n\n## Sub\n### S3\n\n- one\n- two\n1. a\n5. b\nplain para');
  check('blocks: heading levels h1/h2/h3',
    blocks[0].type === 'h1' && blocks[2].type === 'h2' && blocks[3].type === 'h3');
  check('blocks: heading text stripped of #', blocks[0].text === 'Title');
  check('blocks: blank line → blank block', blocks[1].type === 'blank');
  check('blocks: "- " → ul', blocks.filter((b) => b.type === 'ul').length === 2);
  check('blocks: "N. " → ol', blocks.filter((b) => b.type === 'ol').length === 2);
  check('blocks: trailing plain line → p', blocks[blocks.length - 1].type === 'p');
  check('blocks: "**bold**" (no space) is NOT a bullet',
    parseBlocks('**bold line**')[0].type === 'p');

  // ── composeLines (needs embedded fonts to measure) ───────────────────────────
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  const fontBold = await doc.embedFont(fontBoldBytes, { subset: true });
  const ctx = { font, fontBold, baseSize: 11, lineGap: 4, maxWidth: 460 };

  const cl = composeLines(parseBlocks('# Heading\n\nHello **world**'), ctx);
  const headingLine = cl.find((l) => l.size > 11 && l.segments.length);
  check('compose: heading line is larger than body', !!headingLine && headingLine.size === Math.round(11 * 1.6));
  check('compose: heading uses the bold font', !!headingLine && headingLine.segments.every((s) => s.font === fontBold));
  const mixed = cl.find((l) => l.segments.some((s) => s.font === fontBold) && l.segments.some((s) => s.font === font));
  check('compose: a body line mixes regular + bold runs (from **world**)', !!mixed);

  const listCl = composeLines(parseBlocks('- alpha\n- beta'), ctx);
  const firstListLine = listCl.find((l) => l.segments.length);
  check('compose: bullet marker prepended', !!firstListLine && firstListLine.segments[0].text.startsWith('•'));

  const olCl = composeLines(parseBlocks('1. a\n5. b'), ctx).filter((l) => l.segments.length);
  check('compose: ordered list is renumbered 1..N',
    olCl[0].segments[0].text.startsWith('1.') && olCl[1].segments[0].text.startsWith('2.'));

  // ── end-to-end: the PDF actually draws a heading larger than body + bold font ──
  const a4 = await makeA4();
  const richOut = await renderLetter({
    letterheadPdf: a4, layout: {},
    bodyText: '# Experience Certificate\n\nThis certifies **Asha Rao** was employed.\n\n- Punctual\n- Diligent',
    fields: { date: '09/07/2026', refNo: 'ACME/HR/2026/0100' },
    fontBytes, fontBoldBytes,
  });
  check('e2e: rich body renders to a valid %PDF', isPdf(richOut));
  const tfs = extractTf(richOut);
  const bodyTf = tfs.filter((t) => t.size > 0);
  check('e2e: a heading Tf size larger than the 11pt body is present',
    bodyTf.some((t) => t.size >= 17));
  check('e2e: at least two font resources used (regular + bold)',
    new Set(bodyTf.map((t) => t.name)).size >= 2);

  console.log('');
  console.log(`renderMarkdown test: ${passed} passed, ${failed} failed of ${passed + failed} assertions.`);
  if (failed) { console.log('Discrepancies:'); disc.forEach((d) => console.log('  - ' + d)); process.exitCode = 1; }
}

main().catch((e) => { console.error('renderMarkdown test crashed:', e && e.stack); process.exitCode = 1; });
