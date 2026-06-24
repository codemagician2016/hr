'use strict';

/**
 * competencyRollup.js — Feature 34 §5: PURE competency aggregation (no DB, fully
 * unit-tested). Mirrors goalRollup.js: takes plain rows, returns plain numbers.
 *
 * Competency assessment is captured as EXISTING ReviewResponse rows (no new
 * per-item table): { sectionKey:'competency', itemKey:competencyId, ratingValue }.
 * This module aggregates those rows for one review instance into:
 *   - a per-competency actual proficiency (mean of all competency responses for it),
 *   - an expected-vs-actual GAP against the RoleCompetency map,
 *   - an overall weighted competency score (0..100 of the scale max, or null when
 *     nothing is mapped — never thrown; an unmapped role is "no competencies", not an error).
 *
 * The roll-up is the SAME shape the F8 review already produces (rating rows in,
 * a score + a list out), so the ESS development surface and the board cell drill-down
 * both read it without forking the review.
 */

const { num, round2 } = require('./goalRollup');

const COMPETENCY_SECTION = 'competency';

// Mean of the numeric ratingValues for one competency across all responses for it.
// Multiple perspectives (self/manager/peer) collapse to a single actual; callers
// that want manager-only should pre-filter the responses (the controller does).
function actualForCompetency(responses) {
  let sum = 0;
  let cnt = 0;
  for (const r of responses || []) {
    if (r.ratingValue == null) continue;
    const v = num(r.ratingValue);
    if (Number.isFinite(v)) { sum += v; cnt += 1; }
  }
  return cnt ? round2(sum / cnt) : null;
}

/**
 * Build the expected-vs-actual gap list for one review instance.
 *
 * @param {Array}  responses  ReviewResponse rows (any section; we filter to competency).
 * @param {Array}  roleMaps   RoleCompetency rows for the subject's role
 *                            ([{competencyId, expectedLevel, weight}]).
 * @param {Object} competencyById  optional {id: {code,name,category}} for labels.
 * @returns {{ gaps, overallActual, overallExpected, scorePct, mappedCount }}
 *   gaps: [{ competencyId, code, name, expected, actual, gap, weight }]
 *   gap = actual - expected (negative = below bar). actual null when unrated.
 *   scorePct = Σ(actual×weight)/Σ(expected×weight) × 100, clamped [0,..]; null when
 *   no competency is both mapped AND rated (unmapped role / un-assessed cycle).
 */
function competencyGap(responses, roleMaps, competencyById = {}) {
  const compResponses = (responses || []).filter(
    (r) => r.sectionKey === COMPETENCY_SECTION && r.itemKey != null,
  );
  // Group competency responses by itemKey (= competencyId).
  const byCompetency = new Map();
  for (const r of compResponses) {
    if (!byCompetency.has(r.itemKey)) byCompetency.set(r.itemKey, []);
    byCompetency.get(r.itemKey).push(r);
  }

  const maps = Array.isArray(roleMaps) ? roleMaps : [];
  const gaps = [];
  let weightedActual = 0;
  let weightedExpected = 0;
  let ratedMapped = 0;

  for (const m of maps) {
    const meta = competencyById[m.competencyId] || {};
    const expected = num(m.expectedLevel);
    const rows = byCompetency.get(m.competencyId) || [];
    const actual = actualForCompetency(rows);
    // Default weight = 1 when unset so an all-unweighted set is an equal mean.
    const weight = m.weight != null ? num(m.weight) : 1;
    gaps.push({
      competencyId: m.competencyId,
      code: meta.code || null,
      name: meta.name || null,
      category: meta.category || null,
      expected,
      actual,
      gap: actual == null ? null : round2(actual - expected),
      weight: m.weight != null ? round2(weight) : null,
    });
    if (actual != null && expected > 0) {
      weightedActual += actual * weight;
      weightedExpected += expected * weight;
      ratedMapped += 1;
    }
  }

  const scorePct = ratedMapped > 0 && weightedExpected > 0
    ? round2((weightedActual / weightedExpected) * 100)
    : null;

  return {
    gaps,
    mappedCount: maps.length,
    ratedMappedCount: ratedMapped,
    scorePct, // % of the expected bar achieved (100 = exactly meets, >100 = exceeds)
  };
}

module.exports = { COMPETENCY_SECTION, actualForCompetency, competencyGap };
