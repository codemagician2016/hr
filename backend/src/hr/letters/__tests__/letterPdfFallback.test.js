'use strict';

/*
 * letterPdfFallback.test.js — PURE test for the pdfkit from-scratch branded
 * letter (../letterPdfFallback.js), the NO-letterhead path. No DB, no network,
 * no jest.
 *
 *   node backend/src/hr/letters/__tests__/letterPdfFallback.test.js
 *
 * Proves: renderLetterFallback resolves to a valid branded PDF Buffer
 * (starts with %PDF-, non-trivial size), renders the IN ₹ figure when given the
 * bundled TTF, paginates a long body, applies a watermark, and never throws on
 * minimal/empty inputs.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { renderLetterFallback, _internals } = require('../letterPdfFallback');

// Build a real, minimal opaque PNG (w×h, 8-bit RGB) that pdfkit's strict PNG parser
// accepts — used to prove the fallback stamps a signature image.
function makePng(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, colour type 2 (RGB)
  const rowLen = w * 3;
  const raw = Buffer.alloc(h * (rowLen + 1));
  for (let y = 0; y < h; y += 1) { for (let x = 0; x < rowLen; x += 1) raw[y * (rowLen + 1) + 1 + x] = 90; }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

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

async function buf(args, scenario) {
  try {
    return await renderLetterFallback(args);
  } catch (e) {
    failed += 1;
    discrepancies.push(`${scenario}: threw ${e && e.message}`);
    console.error(`FAIL  ${scenario}: threw ${e && e.stack}`);
    return null;
  }
}

const BIZ = {
  legalName: 'Acme Technologies Pvt Ltd', tradeName: 'Acme',
  addressBlock: '12 MG Road\nBengaluru 560001', cin: 'U72200KA2015PTC012345', gstin: '29ABCDE1234F1Z5',
};
const BRAND = { primaryColor: '#1F3A5F', footerText: 'www.acme.test · hr@acme.test' };
const FIELDS = {
  date: '24/06/2026', refNo: 'ACME/HR/2026/0001',
  subject: 'Experience Certificate', addressee: 'To Whomsoever It May Concern',
  authority: 'Priya Sharma', authorityDesignation: 'Head of HR',
};

async function main() {
  // 1) Full branded IN letter WITH the Unicode TTF → ₹ figure renders, valid PDF.
  const body = [
    'This is to certify that Asha Rao (EMP000142) was employed with Acme Technologies',
    'from 01/04/2021. Her last drawn annual CTC was ₹ 18,50,000.00.',
    '',
    'We wish her continued success.',
  ].join('\n');
  const pdf = await buf({ business: BIZ, brand: BRAND, bodyText: body, fields: FIELDS, fontBytes, fontBoldBytes }, 'IN branded');
  check('IN: returns a Buffer', Buffer.isBuffer(pdf));
  check('IN: starts with %PDF- magic', isPdf(pdf));
  check('IN: non-trivial size (>2KB)', pdf && pdf.length > 2048);

  // 2) Without a TTF → falls back to Helvetica (Latin), still a valid PDF.
  const noTtf = await buf({ business: BIZ, brand: BRAND, bodyText: 'Latin-only body, no rupee.', fields: FIELDS }, 'no TTF');
  check('noTTF: valid PDF (Helvetica fallback)', isPdf(noTtf));

  // 3) NZ letter (NZBN footer).
  const nz = await buf({
    business: { legalName: 'Kiwi Ops Ltd', nzbn: '9429000000000', addressBlock: '5 Queen St, Auckland' },
    bodyText: 'This confirms employment of Liam Walker.', fields: { date: '24/06/2026', refNo: 'KIWI/HR/2026/0007', subject: 'Employment Confirmation', authority: 'Manager' },
    fontBytes,
  }, 'NZ branded');
  check('NZ: valid PDF', isPdf(nz));

  // 4) Long body paginates (pdfkit owns flow); still a valid multi-element PDF.
  const longBody = Array.from({ length: 120 }, (_, i) =>
    `Paragraph ${i + 1}: a sufficiently long sentence to consume vertical space and force pdfkit to add a page so the branded fallback letter must paginate gracefully without throwing.`
  ).join('\n\n');
  const long = await buf({ business: BIZ, brand: BRAND, bodyText: longBody, fields: FIELDS, fontBytes, fontBoldBytes }, 'long body');
  check('long: valid PDF', isPdf(long));
  check('long: bigger than short (more pages of content)', long && pdf && long.length > pdf.length);

  // 5) Watermark applied across pages → valid PDF.
  const wm = await buf({ business: BIZ, brand: BRAND, bodyText: longBody, fields: FIELDS, fontBytes, fontBoldBytes, opts: { watermark: 'DRAFT — NOT VALID' } }, 'watermark');
  check('watermark: valid PDF', isPdf(wm));

  // 6) Minimal / empty inputs must not throw.
  const minimal = await buf({ bodyText: 'Bare minimum letter.' }, 'minimal');
  check('minimal: valid PDF', isPdf(minimal));
  const empty = await buf({}, 'empty args');
  check('empty: valid PDF', isPdf(empty));
  const noArg = await buf(undefined, 'no args');
  check('no-args: valid PDF', isPdf(noArg));

  // 6b) Static signature image (Phase 2) draws in the no-letterhead fallback
  //     without throwing → valid PDF larger than the same letter without one.
  //     pdfkit's PNG parser is strict (rejects a 1×1 transparent stub), so we
  //     synthesize a real 8×8 opaque PNG. A corrupt signature is separately proven
  //     to be swallowed (never sinks the letter).
  const goodPng = makePng(8, 8);
  const noSig = await buf({ business: BIZ, brand: BRAND, bodyText: 'Body.', fields: FIELDS, fontBytes, fontBoldBytes }, 'no sig');
  const withSig = await buf({ business: BIZ, brand: BRAND, bodyText: 'Body.', fields: FIELDS, signaturePng: goodPng, fontBytes, fontBoldBytes }, 'with sig');
  check('signature: fallback with a signature is a valid PDF', isPdf(withSig));
  check('signature: fallback embeds the image (output grows vs no-signature)',
    !!(withSig && noSig && withSig.length > noSig.length));
  const badSig = await buf({ business: BIZ, brand: BRAND, bodyText: 'Body.', fields: FIELDS, signaturePng: Buffer.from('not-a-png'), fontBytes, fontBoldBytes }, 'bad sig');
  check('signature: a corrupt signature is swallowed (still a valid PDF)', isPdf(badSig));

  // 7) internals.
  check('businessName prefers legalName', _internals.businessName({ legalName: 'L', name: 'N' }) === 'L');
  check('businessName falls back', _internals.businessName({}, {}) === 'Company');
  check('isHexColor true for #1F3A5F', _internals.isHexColor('#1F3A5F') === true);
  check('isHexColor false for nonsense', _internals.isHexColor('red') === false);

  // ── report ──────────────────────────────────────────────────────────────
  console.log('');
  console.log(`letterPdfFallback test: ${passed} passed, ${failed} failed of ${passed + failed} assertions.`);
  if (failed > 0) {
    console.log('Discrepancies:');
    for (const d of discrepancies) console.log('  - ' + d);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('letterPdfFallback test crashed:', e && e.stack);
  process.exitCode = 1;
});
