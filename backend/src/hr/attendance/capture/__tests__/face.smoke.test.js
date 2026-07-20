'use strict';

/*
 * face.smoke.test.js — Feature 39 ONNX face-engine smoke. Exercises the FULL
 * pipeline (sharp decode → letterbox → SCRFD session → decode → gates) without
 * needing a real face photo: a synthetic noise image must yield a clean NO_FACE,
 * never a crash. SKIPS (exit 0) when the native deps or model files are absent so
 * CI/boxes without models stay green (they run the stub matcher anyway).
 *
 * Also proves the align.js similarity estimator round-trips a known transform, and
 * that registerMatcher swaps the active matcher (the boot path contract).
 *
 * Plain-node:  node backend/src/hr/attendance/capture/__tests__/face.smoke.test.js
 */

const assert = require('assert');
const { estimateSimilarity, warpToTemplate, ARCFACE_TEMPLATE } = require('../face/align');
const faceMatcher = require('../faceMatcher');

let passed = 0;
let failed = 0;
const fails = [];
function check(name, cond) {
  if (cond) { passed += 1; } else { failed += 1; fails.push(name); console.error(`  FAIL  ${name}`); }
}

/* ── align.js (pure — always runs) ──────────────────────────────────────────*/
{
  // A known similarity: scale 2, rotation 90° (a,b)=(0,2), translation (10,-5).
  const src = [[0, 0], [1, 0], [0, 1], [1, 1], [2, 3]];
  const T = { a: 0, b: 2, tx: 10, ty: -5 };
  const dst = src.map(([x, y]) => [T.a * x - T.b * y + T.tx, T.b * x + T.a * y + T.ty]);
  const est = estimateSimilarity(src, dst);
  check('similarity round-trip a', Math.abs(est.a - T.a) < 1e-9);
  check('similarity round-trip b', Math.abs(est.b - T.b) < 1e-9);
  check('similarity round-trip tx', Math.abs(est.tx - T.tx) < 1e-9);
  check('similarity round-trip ty', Math.abs(est.ty - T.ty) < 1e-9);
  check('degenerate (coincident) input → null', estimateSimilarity([[1, 1], [1, 1], [1, 1]], [[0, 0], [1, 1], [2, 2]]) === null);

  // Identity landmarks: warping with kps == template must sample near-identity.
  const w = 200; const h = 200;
  const raw = new Uint8Array(w * h * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 7) % 251;
  const crop = warpToTemplate(raw, w, h, 3, ARCFACE_TEMPLATE.map((p) => [p[0], p[1]]));
  check('identity warp produces a 112×112×3 crop', crop && crop.length === 112 * 112 * 3);
  // Spot-check one interior pixel equals the source pixel (identity mapping).
  const px = (60 * 112 + 60) * 3;
  const sp = (60 * w + 60) * 3;
  check('identity warp preserves pixels', Math.abs(crop[px] - raw[sp]) <= 1);
}

/* ── registerMatcher swap contract ──────────────────────────────────────────*/
{
  const before = faceMatcher.getMatcher();
  const dummy = { id: 'dummy', embed: async () => ({ embedding: [1], matcher: 'dummy' }), matchFace: async () => ({ score: 1, matched: true, status: 'MATCHED', matcher: 'dummy' }) };
  faceMatcher.registerMatcher(dummy);
  check('registerMatcher swaps the active impl', faceMatcher.getMatcher().id === 'dummy');
  let threw = false;
  try { faceMatcher.registerMatcher({}); } catch (_e) { threw = true; }
  check('registerMatcher validates the interface', threw);
  faceMatcher.registerMatcher(before.id ? before : faceMatcher.stubMatcher); // restore
}

/* ── ONNX full-pipeline smoke (skips without deps/models) ───────────────────*/
(async () => {
  let onnx;
  try {
    onnx = require('../face/onnxMatcher');
    if (!onnx.modelsPresent(onnx.defaultModelsDir())) throw new Error('models missing');
    require('sharp');
    require('onnxruntime-node');
  } catch (e) {
    console.log(`face.smoke: SKIP onnx pipeline (${e.message}); align/register: ${passed} passed, ${failed} failed`);
    if (failed) { console.error('FAILED:', fails.join('; ')); process.exit(1); }
    return;
  }

  const sharp = require('sharp');
  // Synthetic noise image — decodable, but contains no face.
  const noise = Buffer.alloc(320 * 320 * 3);
  for (let i = 0; i < noise.length; i += 1) noise[i] = Math.floor(Math.random() * 256);
  const png = await sharp(noise, { raw: { width: 320, height: 320, channels: 3 } }).png().toBuffer();
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

  // embed(): a no-face image must throw the typed FaceError, not crash.
  let code = null;
  const t0 = Date.now();
  try {
    await onnx.embedFromDataUrl(dataUrl, { purpose: 'enroll' });
  } catch (e) {
    code = e instanceof onnx.FaceError ? e.code : `UNEXPECTED:${e.message}`;
  }
  check(`noise image → NO_FACE (got ${code})`, code === 'NO_FACE');
  console.log(`  (pipeline ran in ${Date.now() - t0}ms — models loaded + inferenced)`);

  // matchFace(): same no-face live image vs a fake reference → NO_MATCH score 0
  // (identity not proven = failed match, never an engine error).
  const ref = new Array(512).fill(0).map((_, i) => (i % 2 ? 0.03 : -0.03));
  const v = await onnx.onnxMatcher.matchFace(ref, dataUrl, { threshold: 0.7 });
  check('matchFace(no-face live) → NO_MATCH score 0', v.status === 'NO_MATCH' && v.score === 0 && v.matched === false);

  // matchFace with no reference → NO_REFERENCE; with no live image → SKIPPED.
  const nr = await onnx.onnxMatcher.matchFace(null, dataUrl, {});
  check('matchFace(no reference) → NO_REFERENCE', nr.status === 'NO_REFERENCE');
  const sk = await onnx.onnxMatcher.matchFace(ref, null, {});
  check('matchFace(no live) → SKIPPED', sk.status === 'SKIPPED');

  // Malformed data URL → DECODE_FAILED (typed, not a crash).
  let decodeCode = null;
  try { await onnx.embedFromDataUrl('data:image/png;base64,zzzz', {}); } catch (e) { decodeCode = e.code; }
  check('garbage bytes → DECODE_FAILED', decodeCode === 'DECODE_FAILED');

  console.log(`face.smoke: ${passed} passed, ${failed} failed`);
  if (failed) { console.error('FAILED:', fails.join('; ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
