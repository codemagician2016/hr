'use strict';

/**
 * onnxMatcher.js — the REAL face matcher (Feature 39): InsightFace SCRFD-500M
 * detection + ArcFace (w600k MobileFaceNet) 512-d embeddings via onnxruntime-node,
 * entirely server-side and self-hosted. DPDP posture: the selfie bytes and the
 * derived embedding never leave this process — no third-party biometric processor.
 *
 * Pipeline (embed):
 *   data URL → sharp decode (+EXIF rotate, alpha stripped, bounded to ≤1600px)
 *   → letterboxed 640×640 → SCRFD detect (scrfd.js pure decode, NMS)
 *   → largest face + quality gates → 5-landmark similarity alignment (align.js)
 *   → 112×112 ArcFace crop → 512-d embedding, L2-normalised.
 *
 * Score contract (matchFace): score = (cosine + 1) / 2 ∈ [0,1]. ArcFace same-person
 * raw cosine ≈ 0.5–0.8, different-person < 0.3, so the policy default threshold 0.7
 * (raw 0.4) is a sound accept bar (docs/features/39 §2).
 *
 * Failure posture:
 *   - embed() throws FaceError with .code NO_FACE | FACE_TOO_SMALL | MULTIPLE_FACES |
 *     DECODE_FAILED (enrolment surfaces these as 422 retake messages).
 *   - matchFace() NEVER throws: a live selfie with no usable face is an identity
 *     failure → NO_MATCH (score 0); an internal engine fault → NEEDS_REVIEW so a
 *     punch is never 500'd or silently passed by a broken matcher.
 *
 * Models are lazy-loaded once from FACE_MODELS_DIR (default backend/models/face).
 */

const path = require('path');
const fs = require('fs');
const { decodeOutputs } = require('./scrfd');
const { warpToTemplate, ARCFACE_SIZE } = require('./align');
const { cosineSimilarity } = require('../faceMatcher');

const DET_INPUT = 640;
const DET_SCORE_THRESH = 0.5;
const MIN_FACE_PX_ENROLL = 60; // min bbox side (normalized-image px) for a reference
const MIN_FACE_PX_MATCH = 40; // punches tolerate smaller/further faces
const NORM_MAX_SIDE = 1600; // bound decode memory; keeps phone selfies plenty sharp

const MATCHER_ID = 'arcface-onnx';

class FaceError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.statusCode = 422;
  }
}

function defaultModelsDir() {
  return process.env.FACE_MODELS_DIR
    || path.join(__dirname, '..', '..', '..', '..', '..', 'models', 'face');
}

function modelPaths(dir) {
  return {
    det: path.join(dir, 'det_500m.onnx'),
    rec: path.join(dir, 'w600k_mbf.onnx'),
  };
}

function modelsPresent(dir) {
  const p = modelPaths(dir);
  return fs.existsSync(p.det) && fs.existsSync(p.rec);
}

// Lazy singletons — onnxruntime-node + sharp are required at first use so merely
// loading this module can never crash a box that lacks the native deps.
let sessionsPromise = null;
function loadSessions(dir) {
  if (!sessionsPromise) {
    sessionsPromise = (async () => {
      const ort = require('onnxruntime-node');
      const p = modelPaths(dir);
      const [det, rec] = await Promise.all([
        ort.InferenceSession.create(p.det, { executionProviders: ['cpu'] }),
        ort.InferenceSession.create(p.rec, { executionProviders: ['cpu'] }),
      ]);
      return { ort, det, rec };
    })();
    sessionsPromise.catch(() => { sessionsPromise = null; }); // allow retry after a transient failure
  }
  return sessionsPromise;
}

function parseDataUrl(dataUrl) {
  const m = /^data:image\/(?:png|jpe?g|webp);base64,(.*)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  try { return Buffer.from(m[1], 'base64'); } catch (_e) { return null; }
}

// Decode + normalise the source image: EXIF-rotated, alpha stripped, ≤1600px.
async function decodeImage(dataUrl) {
  const sharp = require('sharp');
  const buf = parseDataUrl(dataUrl);
  if (!buf || !buf.length) throw new FaceError('DECODE_FAILED', 'Image could not be decoded');
  try {
    const { data, info } = await sharp(buf)
      .rotate() // respect EXIF orientation — phone selfies are usually rotated
      .removeAlpha()
      .resize(NORM_MAX_SIDE, NORM_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels };
  } catch (_e) {
    throw new FaceError('DECODE_FAILED', 'Image could not be decoded');
  }
}

// Letterbox the normalised image onto a DET_INPUT square (top-left paste, black
// padding — the reference InsightFace preprocessing) and build the NCHW float32
// input: (px − 127.5) / 128, RGB planes.
async function buildDetInput(img) {
  const sharp = require('sharp');
  const scale = Math.min(DET_INPUT / img.width, DET_INPUT / img.height);
  const nw = Math.max(1, Math.round(img.width * scale));
  const nh = Math.max(1, Math.round(img.height * scale));
  const { data } = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: img.channels } })
    .resize(nw, nh)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const plane = DET_INPUT * DET_INPUT;
  const input = new Float32Array(3 * plane).fill((0 - 127.5) / 128); // black padding, normalised
  for (let y = 0; y < nh; y += 1) {
    for (let x = 0; x < nw; x += 1) {
      const s = (y * nw + x) * 3;
      const d = y * DET_INPUT + x;
      input[d] = (data[s] - 127.5) / 128; // R
      input[plane + d] = (data[s + 1] - 127.5) / 128; // G
      input[2 * plane + d] = (data[s + 2] - 127.5) / 128; // B
    }
  }
  return { input, scale };
}

// Run detection → detections in NORMALISED-image coordinates.
async function detectFaces(sessions, img) {
  const { ort, det } = sessions;
  const { input, scale } = await buildDetInput(img);
  const tensor = new ort.Tensor('float32', input, [1, 3, DET_INPUT, DET_INPUT]);
  const out = await det.run({ [det.inputNames[0]]: tensor });
  const tensors = det.outputNames.map((n) => out[n]);
  const dets = decodeOutputs(tensors, { inputSize: DET_INPUT, scoreThresh: DET_SCORE_THRESH });
  return dets.map((d) => ({
    score: d.score,
    bbox: d.bbox.map((v) => v / scale),
    kps: d.kps ? d.kps.map(([x, y]) => [x / scale, y / scale]) : null,
  }));
}

function bboxArea(b) { return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]); }
function bboxMinSide(b) { return Math.min(Math.max(0, b[2] - b[0]), Math.max(0, b[3] - b[1])); }

// Align + embed ONE detection → L2-normalised 512-d Array.
async function embedDetection(sessions, img, det) {
  const { ort, rec } = sessions;
  const crop = warpToTemplate(img.data, img.width, img.height, img.channels, det.kps);
  if (!crop) throw new FaceError('NO_FACE', 'Face landmarks were degenerate');
  const plane = ARCFACE_SIZE * ARCFACE_SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    input[i] = (crop[i * 3] - 127.5) / 127.5; // R
    input[plane + i] = (crop[i * 3 + 1] - 127.5) / 127.5; // G
    input[2 * plane + i] = (crop[i * 3 + 2] - 127.5) / 127.5; // B
  }
  const tensor = new ort.Tensor('float32', input, [1, 3, ARCFACE_SIZE, ARCFACE_SIZE]);
  const out = await rec.run({ [rec.inputNames[0]]: tensor });
  const raw = out[rec.outputNames[0]].data;
  // L2-normalise so cosine is a pure dot product downstream.
  let norm = 0;
  for (let i = 0; i < raw.length; i += 1) norm += raw[i] * raw[i];
  norm = Math.sqrt(norm) || 1;
  const embedding = new Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) embedding[i] = raw[i] / norm;
  return embedding;
}

/**
 * embedFromDataUrl(dataUrl, { purpose:'enroll'|'match' }) →
 *   { embedding:number[512], detScore, faceCount, matcher } — throws FaceError.
 * Enrolment is strict (min size 60px, ambiguity between two similar-size faces →
 * MULTIPLE_FACES so a bystander can never become the reference); matching keeps the
 * largest face (background people in an office selfie are normal).
 */
async function embedFromDataUrl(dataUrl, opts = {}) {
  const purpose = opts.purpose === 'enroll' ? 'enroll' : 'match';
  const dir = opts.modelsDir || defaultModelsDir();
  const sessions = await loadSessions(dir);
  const img = await decodeImage(dataUrl);
  const dets = (await detectFaces(sessions, img)).filter((d) => d.kps);
  if (!dets.length) throw new FaceError('NO_FACE', 'No face was detected in the photo');
  dets.sort((a, b) => bboxArea(b.bbox) - bboxArea(a.bbox));
  const best = dets[0];
  const minSide = purpose === 'enroll' ? MIN_FACE_PX_ENROLL : MIN_FACE_PX_MATCH;
  if (bboxMinSide(best.bbox) < minSide) {
    throw new FaceError('FACE_TOO_SMALL', 'Move closer — the face is too small in the frame');
  }
  if (purpose === 'enroll' && dets.length > 1 && bboxArea(dets[1].bbox) >= bboxArea(best.bbox) * 0.6) {
    throw new FaceError('MULTIPLE_FACES', 'More than one face is in the frame — retake alone');
  }
  const embedding = await embedDetection(sessions, img, best);
  return { embedding, detScore: best.score, faceCount: dets.length, matcher: MATCHER_ID };
}

// ── the pluggable-matcher interface (faceMatcher.registerMatcher contract) ────
const onnxMatcher = {
  id: MATCHER_ID,

  async embed(liveImage, opts = {}) {
    const r = await embedFromDataUrl(liveImage, { ...opts, purpose: opts.purpose || 'enroll' });
    return { embedding: r.embedding, matcher: MATCHER_ID, detScore: r.detScore, faceCount: r.faceCount };
  },

  async matchFace(refEmbedding, liveImage, opts = {}) {
    if (!liveImage) return { score: null, matched: null, status: 'SKIPPED', matcher: MATCHER_ID };
    if (!Array.isArray(refEmbedding) || refEmbedding.length === 0) {
      return { score: null, matched: null, status: 'NO_REFERENCE', matcher: MATCHER_ID };
    }
    const threshold = Number.isFinite(Number(opts.threshold)) ? Number(opts.threshold) : 0.7;
    try {
      const live = await embedFromDataUrl(liveImage, { purpose: 'match' });
      const raw = cosineSimilarity(refEmbedding.map(Number), live.embedding);
      if (raw == null) return { score: null, matched: null, status: 'NEEDS_REVIEW', matcher: MATCHER_ID };
      const score = Math.max(0, Math.min(1, (raw + 1) / 2));
      const matched = score >= threshold;
      return { score, matched, status: matched ? 'MATCHED' : 'NO_MATCH', matcher: MATCHER_ID };
    } catch (e) {
      if (e instanceof FaceError && (e.code === 'NO_FACE' || e.code === 'FACE_TOO_SMALL')) {
        // No provable identity in the live shot — that IS a failed match, not an error.
        return { score: 0, matched: false, status: 'NO_MATCH', matcher: MATCHER_ID };
      }
      // Engine fault (model/native hiccup) — defer to a human, never block the punch path.
      return { score: null, matched: null, status: 'NEEDS_REVIEW', matcher: MATCHER_ID };
    }
  },
};

module.exports = {
  onnxMatcher,
  embedFromDataUrl,
  FaceError,
  modelsPresent,
  defaultModelsDir,
  MATCHER_ID,
};
