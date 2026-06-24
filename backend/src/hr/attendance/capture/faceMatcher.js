'use strict';

/**
 * faceMatcher.js — the PLUGGABLE face-matcher for the FACE capture mode.
 *
 * INTERFACE (every matcher implements):
 *
 *   matchFace(refEmbedding, liveImage, opts) -> Promise<{
 *     score:   Number|null,   // similarity in [0,1] (1 = same face), or null if not computed
 *     matched: Boolean|null,  // score >= threshold, or null when undecidable (→ NEEDS_REVIEW)
 *     status:  'MATCHED'|'NO_MATCH'|'NEEDS_REVIEW'|'NO_REFERENCE'|'SKIPPED',
 *     matcher: String,        // impl id ("stub" | "face-api" | …) for audit
 *   }>
 *
 *   embed(liveImage, opts) -> Promise<{ embedding: number[]|null, matcher: String }>
 *     // Called once at ENROLMENT to compute the reference vector stored on
 *     // FaceEnrollment.embedding. A matcher that can't embed (the stub) returns
 *     // { embedding: null } and the live path falls back to NEEDS_REVIEW.
 *
 * ── WHICH IMPLEMENTATION SHIPS (v1) ──────────────────────────────────────────
 * The DEFAULT and only registered matcher is **stubMatcher**. No JS face-embedding
 * library (face-api.js / @vladmandic/face-api / @tensorflow/tfjs-node) is installed
 * in this environment, and those carry heavy native (libtensorflow) deps that are
 * not appropriate to add here. So the stub:
 *   - embed():     returns { embedding: null } — nothing is computed; the selfie is
 *                  still STORED (the controller persists imageUrl) for audit.
 *   - matchFace(): returns status NEEDS_REVIEW (score null, matched null) whenever a
 *                  live selfie is present and a reference exists, so an HR admin
 *                  manually verifies via the review queue. A FACE-required punch with
 *                  NO selfie → status SKIPPED at this layer (the policy layer turns a
 *                  missing-required-selfie into a hard reject / flag); a FACE-required
 *                  punch with no enrolled reference → NO_REFERENCE.
 *
 * Liveness detection (anti-photo / anti-replay) is OUT OF SCOPE for v1 — NOTED.
 *
 * ── SWAPPING IN A REAL MATCHER ───────────────────────────────────────────────
 * Drop a module exporting { matchFace, embed } and call `registerMatcher(impl)` at
 * boot (e.g. behind an env flag once face-api is installed). cosineSimilarity()
 * below is exported so a real impl can reuse it once it produces 128-d embeddings.
 * Nothing else in the capture/punch path changes — it only ever calls
 * getMatcher().matchFace()/embed().
 */

// Cosine similarity of two equal-length numeric vectors → [-1,1] (we clamp the
// FACE score to [0,1] at the call site). Exported for a real embedding matcher.
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── stub matcher (the default v1 impl) ───────────────────────────────────────
const stubMatcher = {
  id: 'stub',
  // No embedding computed — the selfie is stored by the controller for audit.
  async embed() {
    return { embedding: null, matcher: 'stub' };
  },
  // Always defer to a human when we have a live selfie + a reference; otherwise
  // surface the structural cases the policy layer keys off.
  async matchFace(refEmbedding, liveImage /* , opts */) {
    if (!liveImage) return { score: null, matched: null, status: 'SKIPPED', matcher: 'stub' };
    return { score: null, matched: null, status: 'NEEDS_REVIEW', matcher: 'stub' };
  },
};

// ── example real matcher (NOT registered; reference shape only) ───────────────
// When a real embedding matcher is installed it would produce a 128-d vector at
// enrol time (embed) and compare cosine similarity at punch time (matchFace):
//
//   async matchFace(refEmbedding, liveImage, { threshold }) {
//     if (!liveImage) return { score: null, matched: null, status: 'SKIPPED', matcher: 'face-api' };
//     if (!Array.isArray(refEmbedding)) return { score: null, matched: null, status: 'NO_REFERENCE', matcher: 'face-api' };
//     const live = await computeEmbedding(liveImage);          // face-api detect+descriptor
//     const raw = cosineSimilarity(refEmbedding, live);        // [-1,1]
//     const score = raw == null ? null : Math.max(0, Math.min(1, (raw + 1) / 2));
//     if (score == null) return { score: null, matched: null, status: 'NEEDS_REVIEW', matcher: 'face-api' };
//     const matched = score >= threshold;
//     return { score, matched, status: matched ? 'MATCHED' : 'NO_MATCH', matcher: 'face-api' };
//   }

let active = stubMatcher;

function registerMatcher(impl) {
  if (!impl || typeof impl.matchFace !== 'function' || typeof impl.embed !== 'function') {
    throw new Error('a face matcher must implement { matchFace, embed }');
  }
  active = impl;
  return active;
}

function getMatcher() {
  return active;
}

module.exports = {
  getMatcher,
  registerMatcher,
  cosineSimilarity,
  stubMatcher,
  // re-exported for direct use/tests
  matchFace: (...args) => active.matchFace(...args),
  embed: (...args) => active.embed(...args),
};
