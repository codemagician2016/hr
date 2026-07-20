'use strict';

/**
 * scrfd.js — PURE decode for the InsightFace SCRFD face detector (det_500m.onnx,
 * Feature 39). No onnxruntime import, no I/O — takes the raw output tensors and
 * returns detections, so the decode math is plain-node unit-testable.
 *
 * SCRFD-500M head layout (buffalo_sc pack): 3 FPN strides [8,16,32], 2 anchors per
 * cell, 9 output tensors — per stride a score map [N,1], a bbox-distance map [N,4]
 * and a 5-landmark map [N,10], where N = (inputSize/stride)^2 * 2. Distances are in
 * STRIDE units; boxes/landmarks decode as offsets from the anchor centre
 * (distance2bbox / distance2kps in the reference Python).
 *
 * Output tensors arrive UNLABELLED (the ONNX graph uses opaque names), so we
 * classify each tensor by its (rows, lastDim) signature — unambiguous because every
 * stride has a distinct row count and every head a distinct channel width.
 */

// Classify one runtime tensor {dims, data} → { n, d, data } with the batch dim folded.
function foldTensor(t) {
  const dims = t.dims || [];
  if (dims.length === 3 && dims[0] === 1) return { n: dims[1], d: dims[2], data: t.data };
  if (dims.length === 2) return { n: dims[0], d: dims[1], data: t.data };
  return null;
}

/**
 * decodeOutputs(tensors, opts) → [{ score, bbox:[x1,y1,x2,y2], kps:[[x,y]×5] }]
 * in INPUT-CANVAS coordinates (the caller maps back through its letterbox scale).
 *
 * @param tensors   array of { dims:number[], data:Float32Array } (any order)
 * @param opts      { inputSize=640, scoreThresh=0.5, strides=[8,16,32], numAnchors=2 }
 */
function decodeOutputs(tensors, opts = {}) {
  const inputSize = opts.inputSize || 640;
  const scoreThresh = opts.scoreThresh == null ? 0.5 : opts.scoreThresh;
  const strides = opts.strides || [8, 16, 32];
  const numAnchors = opts.numAnchors || 2;

  // Index the folded tensors by rows × lastDim so we can pick each head per stride.
  const folded = tensors.map(foldTensor).filter(Boolean);
  const byKey = new Map();
  for (const f of folded) byKey.set(`${f.n}x${f.d}`, f);

  const dets = [];
  for (const stride of strides) {
    const cells = Math.ceil(inputSize / stride);
    const n = cells * cells * numAnchors;
    const scoreT = byKey.get(`${n}x1`);
    const bboxT = byKey.get(`${n}x4`);
    const kpsT = byKey.get(`${n}x10`);
    if (!scoreT || !bboxT) continue; // tolerate a kps-less export

    for (let i = 0; i < n; i += 1) {
      const score = scoreT.data[i];
      if (score < scoreThresh) continue;
      // Anchor centre: centres iterate row-major over cells, each repeated numAnchors×.
      const cell = Math.floor(i / numAnchors);
      const cy = Math.floor(cell / cells) * stride;
      const cx = (cell % cells) * stride;
      // distance2bbox — distances are in stride units.
      const l = bboxT.data[i * 4] * stride;
      const t = bboxT.data[i * 4 + 1] * stride;
      const r = bboxT.data[i * 4 + 2] * stride;
      const b = bboxT.data[i * 4 + 3] * stride;
      const bbox = [cx - l, cy - t, cx + r, cy + b];
      let kps = null;
      if (kpsT) {
        kps = [];
        for (let k = 0; k < 5; k += 1) {
          kps.push([cx + kpsT.data[i * 10 + k * 2] * stride, cy + kpsT.data[i * 10 + k * 2 + 1] * stride]);
        }
      }
      dets.push({ score, bbox, kps });
    }
  }
  return nms(dets, opts.iouThresh == null ? 0.4 : opts.iouThresh);
}

// Greedy IoU NMS, highest score first.
function nms(dets, iouThresh) {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const d of sorted) {
    let keep = true;
    for (const k of kept) {
      if (iou(d.bbox, k.bbox) > iouThresh) { keep = false; break; }
    }
    if (keep) kept.push(d);
  }
  return kept;
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}

module.exports = { decodeOutputs, nms, iou, foldTensor };
