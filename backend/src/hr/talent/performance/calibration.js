'use strict';

/**
 * calibration.js — Feature 8 §5.7: distribution statistics for a calibration
 * group. PURE (no DB). The system WARNS against a target curve (forcedDistribution)
 * but NEVER auto-clamps in v1 — the histogram + flags are advisory only.
 */

const { num } = require('./goalRollup');

// Bucket a list of instances by their effective rating (calibratedRating ??
// managerRating ?? selfRating), returning counts keyed by the scale point value.
//   instances: [{ calibratedRating, managerRating, selfRating }]
//   scalePoints: [{ value }]
function distribution(instances, scalePoints) {
  const keys = (scalePoints || []).map((p) => String(p.value));
  const counts = {};
  for (const k of keys) counts[k] = 0;
  let rated = 0;
  for (const it of instances) {
    const r = it.calibratedRating != null ? it.calibratedRating
      : it.managerRating != null ? it.managerRating
      : it.selfRating;
    if (r == null) continue;
    const k = String(Math.round(num(r)));
    if (!(k in counts)) counts[k] = 0;
    counts[k] += 1;
    rated += 1;
  }
  return { counts, rated, total: instances.length };
}

// Compare actuals to a forced-distribution target curve, returning per-bucket
// deltas and an overall `withinTolerance` flag. Target curve is a percentage map
// {value: pct}. `tolerancePct` is the soft band (default 10pp).
function distributionWarning(dist, forcedDistributionJson, tolerancePct = 10) {
  if (!forcedDistributionJson || !dist.rated) {
    return { hasTarget: false, withinTolerance: true, buckets: [] };
  }
  const target = forcedDistributionJson;
  const buckets = [];
  let within = true;
  for (const [k, count] of Object.entries(dist.counts)) {
    const actualPct = dist.rated ? (count / dist.rated) * 100 : 0;
    const targetPct = num(target[k]);
    const delta = Math.round((actualPct - targetPct) * 100) / 100;
    const over = Math.abs(delta) > tolerancePct;
    if (over) within = false;
    buckets.push({ value: k, count, actualPct: Math.round(actualPct * 100) / 100, targetPct, delta, exceedsTolerance: over });
  }
  return { hasTarget: true, withinTolerance: within, tolerancePct, buckets };
}

module.exports = { distribution, distributionWarning };
