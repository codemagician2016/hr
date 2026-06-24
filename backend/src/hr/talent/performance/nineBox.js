'use strict';

/**
 * nineBox.js — Feature 34 §5.6/§5.7: PURE 9-box math (no DB). Bands a rating into
 * 1..3, computes the box number, labels it, and wraps calibration.js for the grid
 * concentration warning (box-keyed, reusing the F8 soft-warning engine verbatim).
 *
 * The performance axis is NEVER re-rated here — `bandFromRating` is only ever fed the
 * F8 effective rating (calibratedRating ?? finalRating ?? managerRating, the exact
 * precedence of calibration.js:21). The potential axis is authored on a RatingScale
 * then banded with the SAME function (thresholds are scale-agnostic).
 */

const { num } = require('./goalRollup');
const { distribution, distributionWarning } = require('./calibration');

// The F8 effective-rating precedence (calibration.js:21), centralised so the perf
// axis and the rating histogram always read the SAME source of truth.
function effectiveRating(instance) {
  if (!instance) return null;
  if (instance.calibratedRating != null) return num(instance.calibratedRating);
  if (instance.finalRating != null) return num(instance.finalRating);
  if (instance.managerRating != null) return num(instance.managerRating);
  return null;
}

// Default banding thresholds on a 5-point scale: <3 → 1 (low), 3–<4 → 2 (med),
// ≥4 → 3 (high). Configurable per cycle via nineBoxConfigJson.perfBands as an
// ascending list of { max, band } (band assigned when rating < max; the last entry
// is the catch-all and may omit max). Scale-agnostic: pass thresholds for any scale.
const DEFAULT_PERF_BANDS = [
  { max: 3, band: 1 },
  { max: 4, band: 2 },
  { band: 3 }, // ≥ 4
];

/**
 * Band a rating into 1..3. Returns null for a null/undefined rating (un-rated → can't
 * be placed). `bands` is an ascending [{max, band}] list; the entry with no `max`
 * (or the highest) is the catch-all.
 */
function bandFromRating(rating, bands = DEFAULT_PERF_BANDS) {
  if (rating == null) return null;
  const r = num(rating);
  if (!Number.isFinite(r)) return null;
  const list = Array.isArray(bands) && bands.length ? bands : DEFAULT_PERF_BANDS;
  for (const b of list) {
    if (b.max == null) return clampBand(b.band);
    if (r < num(b.max)) return clampBand(b.band);
  }
  // Past every threshold → the band of the last entry (the catch-all).
  return clampBand(list[list.length - 1].band);
}

function clampBand(b) {
  const n = Math.round(num(b));
  if (n < 1) return 1;
  if (n > 3) return 3;
  return n;
}

/**
 * Box number 1..9 from the two bands. Classic layout:
 *   box = (potentialBand - 1) * 3 + performanceBand
 * → Box 1 = low/low (Risk), Box 9 = high/high (Star). Null until BOTH bands set.
 */
function computeBox(performanceBand, potentialBand) {
  if (performanceBand == null || potentialBand == null) return null;
  const p = clampBand(performanceBand);
  const pot = clampBand(potentialBand);
  return (pot - 1) * 3 + p;
}

// The classic 9-box labels (performance →, potential ↑).
const BOX_LABELS = Object.freeze({
  1: 'Risk',
  2: 'Inconsistent Player',
  3: 'Workhorse',
  4: 'Average Performer',
  5: 'Core Player',
  6: 'High Performer',
  7: 'Diamond in the Rough',
  8: 'High Potential',
  9: 'Star',
});

function boxLabel(box) {
  return box == null ? null : (BOX_LABELS[box] || null);
}

/**
 * Grid concentration warning — REUSES calibration.distribution / distributionWarning
 * verbatim, with the BOX NUMBER as the bucket key and the cycle's gridTargetJson as
 * the target curve. Soft and advisory: it never clamps, exactly like the rating
 * histogram warning (calibration.js).
 *
 * @param {Array}  placements  [{ box }] (null boxes are ignored — only placed people).
 * @param {Object} gridTargetJson  optional { "9": pct, "1": pct, ... } target curve.
 * @param {number} tolerancePct
 */
function gridConcentration(placements, gridTargetJson, tolerancePct = 10) {
  // Re-shape placements into the {calibratedRating} contract distribution() expects,
  // mapping box → the bucket key. We bucket on box 1..9.
  const boxPoints = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((v) => ({ value: v }));
  const asInstances = (placements || [])
    .filter((p) => p && p.box != null)
    .map((p) => ({ calibratedRating: num(p.box) }));
  const dist = distribution(asInstances, boxPoints);
  const warning = distributionWarning(dist, gridTargetJson, tolerancePct);
  return { distribution: dist, warning };
}

module.exports = {
  DEFAULT_PERF_BANDS,
  BOX_LABELS,
  effectiveRating,
  bandFromRating,
  computeBox,
  boxLabel,
  gridConcentration,
};
