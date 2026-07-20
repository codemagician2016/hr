'use strict';

/**
 * align.js — PURE face alignment for ArcFace (Feature 39). No I/O, no native deps —
 * plain-node unit-testable.
 *
 * ArcFace expects the face similarity-aligned to a canonical 112×112 template (the
 * standard InsightFace `arcface_dst` 5-point layout: eyes, nose tip, mouth corners).
 * We estimate the least-squares SIMILARITY transform (uniform scale + rotation +
 * translation, NO reflection — the classic closed-form Procrustes fit, equivalent to
 * skimage SimilarityTransform for face landmarks) from the detected 5 landmarks to
 * the template, then inverse-map every output pixel with bilinear sampling. The warp
 * is hand-rolled (12 544 output pixels — trivial) so the result is deterministic and
 * free of any native library's affine-convention ambiguity.
 */

// Canonical ArcFace 112×112 landmark template: [x,y] × (leftEye, rightEye, nose,
// leftMouth, rightMouth) — the standard InsightFace arcface_dst constants.
const ARCFACE_TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

const ARCFACE_SIZE = 112;

/**
 * estimateSimilarity(src, dst) → { a, b, tx, ty } | null
 * The LS similarity mapping src→dst points:  u = a·x − b·y + tx ; v = b·x + a·y + ty.
 * Closed form via centred cross/dot sums. Null on degenerate input (all points
 * coincident) so callers can fail soft.
 */
function estimateSimilarity(src, dst) {
  const n = Math.min(src.length, dst.length);
  if (n < 2) return null;
  let mx = 0; let my = 0; let mu = 0; let mv = 0;
  for (let i = 0; i < n; i += 1) {
    mx += src[i][0]; my += src[i][1]; mu += dst[i][0]; mv += dst[i][1];
  }
  mx /= n; my /= n; mu /= n; mv /= n;
  let sxx = 0; let dotA = 0; let dotB = 0;
  for (let i = 0; i < n; i += 1) {
    const x = src[i][0] - mx; const y = src[i][1] - my;
    const u = dst[i][0] - mu; const v = dst[i][1] - mv;
    sxx += x * x + y * y;
    dotA += x * u + y * v; // aligns with rotation cos·scale
    dotB += x * v - y * u; // aligns with rotation sin·scale
  }
  if (!(sxx > 0)) return null;
  const a = dotA / sxx;
  const b = dotB / sxx;
  return { a, b, tx: mu - a * mx + b * my, ty: mv - b * mx - a * my };
}

/**
 * warpToTemplate(raw, width, height, channels, kps, size?) → Uint8ClampedArray
 * (size×size×3, RGB) — the aligned face crop ArcFace consumes.
 *
 * @param raw       Uint8Array/Buffer of the SOURCE image, row-major, `channels` per px
 * @param kps       detected landmarks [[x,y]×5] in SOURCE coordinates
 */
function warpToTemplate(raw, width, height, channels, kps, size = ARCFACE_SIZE) {
  const M = estimateSimilarity(kps, ARCFACE_TEMPLATE);
  if (!M) return null;
  // Invert  u = a·x − b·y + tx ; v = b·x + a·y + ty   (pure similarity):
  //   [x,y] = (1/(a²+b²)) · [ a·(u−tx) + b·(v−ty),  −b·(u−tx) + a·(v−ty) ]
  const s2 = M.a * M.a + M.b * M.b;
  if (!(s2 > 0)) return null;
  const out = new Uint8ClampedArray(size * size * 3);
  for (let oy = 0; oy < size; oy += 1) {
    for (let ox = 0; ox < size; ox += 1) {
      const du = ox - M.tx;
      const dv = oy - M.ty;
      const sx = (M.a * du + M.b * dv) / s2;
      const sy = (-M.b * du + M.a * dv) / s2;
      const o = (oy * size + ox) * 3;
      // Bilinear sample; out-of-bounds → black (template border).
      const x0 = Math.floor(sx); const y0 = Math.floor(sy);
      if (x0 < -1 || y0 < -1 || x0 > width - 1 || y0 > height - 1) continue;
      const fx = sx - x0; const fy = sy - y0;
      for (let c = 0; c < 3; c += 1) {
        const p00 = sample(raw, width, height, channels, x0, y0, c);
        const p10 = sample(raw, width, height, channels, x0 + 1, y0, c);
        const p01 = sample(raw, width, height, channels, x0, y0 + 1, c);
        const p11 = sample(raw, width, height, channels, x0 + 1, y0 + 1, c);
        out[o + c] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
      }
    }
  }
  return out;
}

function sample(raw, width, height, channels, x, y, c) {
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  return raw[(y * width + x) * channels + c];
}

module.exports = { estimateSimilarity, warpToTemplate, ARCFACE_TEMPLATE, ARCFACE_SIZE };
