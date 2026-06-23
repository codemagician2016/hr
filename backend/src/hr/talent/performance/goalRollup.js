'use strict';

/**
 * goalRollup.js — Feature 8 §5.6: PURE OKR math (no DB, fully unit-tested).
 *
 *   KR.progress        = clamp((current−start)/(target−start), 0, 1) × 100
 *                        DECREASE inverts the numerator (lower-is-better).
 *                        MAINTAIN / BOOLEAN / MILESTONE handled explicitly.
 *   Objective.progress = Σ(KR.progress × KR.weight) / Σ(KR.weight)   (weighted mean)
 *   Parent rollup      = Σ(child.progress × alignmentWeight) / 100   (read-model only)
 *
 * Weight invariants (the controller turns a violation into a 422):
 *   Σ(KR.weight) within an objective         === 100 (±EPS)
 *   Σ(Objective.weight) within (owner,cycle) === 100 (±EPS)
 */

const EPS = 0.01; // Decimal(5,2) tolerance for the Σ=100 invariants.

function num(x) {
  if (x == null) return 0;
  if (typeof x === 'number') return x;
  // Prisma Decimal → number (toNumber) or a numeric string.
  if (typeof x.toNumber === 'function') return x.toNumber();
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Progress of a single KR in [0,100]. `direction` flips the sense for DECREASE.
// BOOLEAN/MILESTONE: current>=target ? 100 : 0. MAINTAIN: 100 while within band of
// target (we treat any current within [target, start] envelope as on-target → 100
// when current===target, else proportional toward target).
function krProgress(kr) {
  const start = num(kr.startValue);
  const target = num(kr.targetValue);
  const current = num(kr.currentValue);
  const type = kr.metricType;
  const dir = kr.direction || 'INCREASE';

  if (type === 'BOOLEAN' || type === 'MILESTONE') {
    // Treat target as the "done" threshold; any current >= target is complete.
    return current >= target ? 100 : 0;
  }

  const span = target - start;
  if (span === 0) {
    // Degenerate target===start: complete iff we've reached/passed it.
    if (dir === 'DECREASE') return current <= target ? 100 : 0;
    return current >= target ? 100 : 0;
  }

  let ratio;
  if (dir === 'DECREASE') {
    // Lower is better: progress as current falls from start toward target.
    ratio = (start - current) / (start - target);
  } else if (dir === 'MAINTAIN') {
    // Distance from target relative to the start gap; on-target = 100.
    const drift = Math.abs(current - target);
    const tolerance = Math.abs(span) || 1;
    ratio = 1 - drift / tolerance;
  } else {
    ratio = (current - start) / span;
  }
  return clamp(ratio, 0, 1) * 100;
}

// Weighted-mean progress for one objective from its KRs. Empty / zero-weight → 0.
function objectiveProgress(keyResults) {
  if (!Array.isArray(keyResults) || keyResults.length === 0) return 0;
  let sumWP = 0;
  let sumW = 0;
  for (const kr of keyResults) {
    const w = num(kr.weight);
    sumWP += krProgress(kr) * w;
    sumW += w;
  }
  if (sumW === 0) return 0;
  return round2(sumWP / sumW);
}

// Read-model parent rollup from aligned children. Each child contributes its own
// progress scaled by the alignment edge weight (a percentage of the parent).
function parentRollup(children) {
  if (!Array.isArray(children) || children.length === 0) return 0;
  let acc = 0;
  for (const c of children) {
    acc += num(c.progress) * (num(c.alignmentWeight) / 100);
  }
  return round2(acc);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

// Σ(weights) === 100 (±EPS). Returns { ok, sum }.
function checkWeightSum(items, field = 'weight') {
  const sum = items.reduce((a, it) => a + num(it[field]), 0);
  return { ok: Math.abs(sum - 100) <= EPS, sum: round2(sum) };
}

module.exports = {
  EPS,
  num,
  clamp,
  krProgress,
  objectiveProgress,
  parentRollup,
  checkWeightSum,
  round2,
};
