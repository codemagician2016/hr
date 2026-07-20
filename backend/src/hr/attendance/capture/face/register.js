'use strict';

/**
 * register.js — boot-time registration of the real face matcher (Feature 39).
 * Required once from hr/routes/index.js (mirrors approvals/registerConsumers.js).
 *
 * Selection:
 *   FACE_MATCHER=stub  → keep the stub (every face punch → NEEDS_REVIEW, as v1).
 *   FACE_MATCHER=onnx  → require the ONNX matcher; a load failure logs loudly.
 *   unset / auto       → use the ONNX matcher when the native deps + model files are
 *                        available, else stay on the stub. A box without models keeps
 *                        punching (review-queue mode) — capture NEVER hard-fails boot.
 */

const faceMatcher = require('../faceMatcher');

let done = false;

function registerFaceMatcher() {
  if (done) return faceMatcher.getMatcher();
  done = true;
  const mode = String(process.env.FACE_MATCHER || 'auto').toLowerCase();
  if (mode === 'stub') return faceMatcher.getMatcher();
  try {
    const { onnxMatcher, modelsPresent, defaultModelsDir } = require('./onnxMatcher');
    if (!modelsPresent(defaultModelsDir())) {
      if (mode === 'onnx') console.error('[face] FACE_MATCHER=onnx but models missing in', defaultModelsDir());
      return faceMatcher.getMatcher();
    }
    // Probe the native deps now (sharp / onnxruntime-node) so a broken install is
    // discovered at boot, not on the first punch.
    require('sharp');
    require('onnxruntime-node');
    faceMatcher.registerMatcher(onnxMatcher);
    console.log('[face] arcface-onnx matcher registered (models:', defaultModelsDir() + ')');
  } catch (e) {
    console.error('[face] real matcher unavailable — staying on stub matcher:', e.message);
  }
  return faceMatcher.getMatcher();
}

module.exports = { registerFaceMatcher };
