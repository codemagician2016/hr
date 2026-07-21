'use strict';

/**
 * enps.js — Feature 33 PURE eNPS + aggregation math (the unit-test target).
 * No prisma, no I/O — every function is a deterministic transform, mirroring the
 * attendance latePenalty / leave reconcile pure modules.
 *
 *   classifyNps(score)                → 'PROMOTER' | 'PASSIVE' | 'DETRACTOR'
 *   computeEnps(scores, k)            → { promoters, passives, detractors, total,
 *                                         promoterPct, passivePct, detractorPct, enps }
 *                                       or { suppressed: true } when total < max(1, k)
 *   aggregateQuestion(question, answers, { k }) → per-type aggregate, k-suppressed
 *   segmentBreakdown(responses, dimension, k, computeGroup)
 *                                     → k-anonymised group list + complement-leak guard
 *
 * k-ANONYMITY: every aggregate (total AND per-segment) is suppressed when computed
 * from fewer than k respondents. A suppressed result carries NO numbers — only
 * { suppressed: true } — so a small cohort can never be read off the dashboard.
 *
 * COMPLEMENT-LEAK GUARD (§6.3): if exactly ONE group would be suppressed, the hidden
 * remainder could be reconstructed as (total − shown groups) — so we also suppress
 * the next-smallest group, guaranteeing a suppressed bucket is never back-computable.
 */

const NPS_MIN = 0;
const NPS_MAX = 10;

/** Promoters 9–10, detractors 0–6, passives 7–8. */
function classifyNps(score) {
  if (score == null || score === '') return null; // Number(null) is 0 — guard explicitly
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  if (s >= 9) return 'PROMOTER';
  if (s <= 6) return 'DETRACTOR';
  return 'PASSIVE';
}

function round1(x) { return Math.round(x * 10) / 10; }

/**
 * eNPS = round(%promoters − %detractors). Passives are excluded from the subtraction
 * but ALWAYS counted/reported for transparency. Integer, −100…+100.
 * Empty or below-k input → { suppressed: true } (NO numbers — k-anonymity).
 */
function computeEnps(scores = [], k = 1) {
  const valid = (Array.isArray(scores) ? scores : [])
    .map(Number)
    .filter((s) => Number.isInteger(s) && s >= NPS_MIN && s <= NPS_MAX);
  const total = valid.length;
  const floor = Math.max(1, Number(k) || 1);
  if (total < floor) return { suppressed: true };

  let promoters = 0; let passives = 0; let detractors = 0;
  for (const s of valid) {
    const c = classifyNps(s);
    if (c === 'PROMOTER') promoters += 1;
    else if (c === 'DETRACTOR') detractors += 1;
    else passives += 1;
  }
  const promoterPct = (promoters / total) * 100;
  const passivePct = (passives / total) * 100;
  const detractorPct = (detractors / total) * 100;
  return {
    promoters, passives, detractors, total,
    promoterPct: round1(promoterPct),
    passivePct: round1(passivePct),
    detractorPct: round1(detractorPct),
    // Compute from the UNROUNDED pcts so display rounding never skews the score.
    enps: Math.round(promoterPct - detractorPct),
  };
}

/**
 * Aggregate one question's answers, k-suppressed.
 *   question — { type, scaleMin, scaleMax, options } (SurveyQuestion shape)
 *   answers  — SurveyAnswer-shaped rows for THIS question:
 *              { numericValue, choiceValues, textValue }
 * Per type:
 *   SCALE/LIKERT → mean + distribution histogram over scaleMin..scaleMax
 *   NPS          → computeEnps
 *   SINGLE/MULTI → per-option counts + pct of respondents ("Other" text EXCLUDED —
 *                  free text only surfaces in the gated verbatims view)
 *   TEXT         → count only (verbatim contents live behind the §6.5 gate)
 */
function aggregateQuestion(question, answers = [], { k = 1 } = {}) {
  const type = question && question.type;
  const rows = Array.isArray(answers) ? answers : [];
  const floor = Math.max(1, Number(k) || 1);

  if (type === 'NPS') {
    const scores = rows.map((a) => a.numericValue).filter((v) => v != null);
    const out = computeEnps(scores, floor);
    return { type, ...out };
  }

  if (type === 'SCALE' || type === 'LIKERT') {
    const values = rows
      .map((a) => Number(a.numericValue))
      .filter((v) => Number.isFinite(v));
    if (values.length < floor) return { type, suppressed: true };
    const lo = Number.isInteger(question.scaleMin) ? question.scaleMin : Math.min(...values);
    const hi = Number.isInteger(question.scaleMax) ? question.scaleMax : Math.max(...values);
    const distribution = [];
    for (let v = lo; v <= hi; v += 1) distribution.push({ value: v, count: 0 });
    const byValue = new Map(distribution.map((d) => [d.value, d]));
    let sum = 0;
    for (const v of values) {
      sum += v;
      const slot = byValue.get(v);
      if (slot) slot.count += 1;
    }
    return { type, count: values.length, mean: round1(sum / values.length), distribution };
  }

  if (type === 'SINGLE' || type === 'MULTI') {
    const answered = rows.filter((a) => (Array.isArray(a.choiceValues) && a.choiceValues.length) || (a.textValue != null && String(a.textValue).trim() !== ''));
    if (answered.length < floor) return { type, suppressed: true };
    const opts = Array.isArray(question.options) ? question.options : [];
    const counts = new Map(opts.map((o) => [o.value, 0]));
    let otherCount = 0;
    for (const a of answered) {
      for (const v of (a.choiceValues || [])) {
        if (counts.has(v)) counts.set(v, counts.get(v) + 1);
      }
      if (a.textValue != null && String(a.textValue).trim() !== '') otherCount += 1;
    }
    return {
      type,
      count: answered.length,
      options: opts.map((o) => ({
        value: o.value,
        label: o.label,
        count: counts.get(o.value) || 0,
        pct: round1(((counts.get(o.value) || 0) / answered.length) * 100),
      })),
      otherCount, // how many picked "Other" — the free text itself stays gated
    };
  }

  if (type === 'TEXT') {
    const count = rows.filter((a) => a.textValue != null && String(a.textValue).trim() !== '').length;
    if (count < floor) return { type, suppressed: true };
    return { type, count }; // count ONLY — contents live behind the verbatims gate
  }

  return { type, suppressed: true };
}

/**
 * k-anonymised segment breakdown with the complement-leak guard.
 *   responses    — rows carrying `.segmentLabel` (null/'' buckets as "Unassigned")
 *   dimension    — echo-only label of the configured breakdown dimension
 *   k            — the survey's minResponsesToShow floor
 *   computeGroup — optional (rowsOfGroup) => aggregate object merged into the shown
 *                  group (e.g. an aggregateQuestion over the group's answers).
 * Returns {
 *   dimension,
 *   groups:            [{ label, count, ...aggregate }]  // ONLY groups with count >= k
 *   suppressedGroups:  <number of hidden groups>          // never their labels/counts
 * }
 * Guard: if EXACTLY one group is suppressed, the next-smallest shown group is
 * suppressed too, so hidden = total − shown can never reconstruct a small cohort.
 */
function segmentBreakdown(responses = [], dimension = null, k = 5, computeGroup = null) {
  const floor = Math.max(1, Number(k) || 1);
  const byLabel = new Map();
  for (const r of (Array.isArray(responses) ? responses : [])) {
    const label = (r && r.segmentLabel != null && String(r.segmentLabel).trim() !== '')
      ? String(r.segmentLabel) : 'Unassigned';
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(r);
  }

  const all = [...byLabel.entries()].map(([label, rows]) => ({ label, rows, count: rows.length }));
  // Deterministic ordering: biggest first, then label.
  all.sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label));

  let shown = all.filter((g) => g.count >= floor);
  let hidden = all.filter((g) => g.count < floor);

  // ── Complement-leak guard (§6.3) ──
  // Exactly one hidden group could be back-computed from total − shown, so hide the
  // next-smallest shown group too (≥2 suppressed, or none).
  if (hidden.length === 1 && shown.length > 0) {
    const nextSmallest = shown[shown.length - 1]; // sorted desc → last is smallest
    shown = shown.slice(0, -1);
    hidden = [...hidden, nextSmallest];
  }

  return {
    dimension: dimension || null,
    groups: shown.map((g) => ({
      label: g.label,
      count: g.count,
      ...(typeof computeGroup === 'function' ? (computeGroup(g.rows) || {}) : {}),
    })),
    // A COUNT of hidden groups only — no labels, no respondent counts, no numbers.
    suppressedGroups: hidden.length,
  };
}

module.exports = { NPS_MIN, NPS_MAX, classifyNps, computeEnps, aggregateQuestion, segmentBreakdown };
