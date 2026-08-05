'use strict';

/**
 * scoring.js — Feature 12 (Recruitment / ATS) PURE scoring engine.
 *
 * Mirrors the `payroll/compliance/india.js` and `talent/performance/` pattern:
 * pure, deterministic, dependency-free (NO Prisma), unit-tested. The controller
 * calls these functions and persists the result snapshot — it never inlines the
 * arithmetic. The merit number is therefore always reproducible and auditable.
 *
 * Three scorers + one orchestrator:
 *   1. scoreScreening(questions, answers)  → application (screening) score + KO
 *   2. scoreInterview(scorecards, {aggregation}) → aggregated interview score
 *   3. computeMeritScore({...}, {weights})  → the blended merit-list sort key
 *   4. recomputeApplicationScore(...)       → the full scoreSnapshot + 3 decimals
 *
 * Money/marks are kept in plain numbers (points, not paise) but rounded to 2dp at
 * the boundary so the persisted Decimal(7,2) columns round-trip exactly.
 */

// ── numeric helpers ──────────────────────────────────────────────────────────
function num(v, dflt = 0) {
  if (v == null || v === '') return dflt;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// Round to 2 decimals (matches Decimal(7,2) persistence); avoids fp drift.
function round2(n) {
  return Math.round((num(n) + Number.EPSILON) * 100) / 100;
}

// Normalise a value to a comparable canonical string for matching against
// ScreeningOption.value / knockoutValue. Booleans → 'true'/'false'.
function canon(v) {
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}

// The set of "passing" values for a knockout question. knockoutValue may be a
// scalar or an array; absent → for BOOLEAN a knockout defaults to requiring true.
function knockoutPassSet(question) {
  const kv = question.knockoutValue;
  let vals;
  if (Array.isArray(kv)) vals = kv;
  else if (kv === null || kv === undefined) vals = question.kind === 'BOOLEAN' ? [true] : [];
  else vals = [kv];
  return new Set(vals.map(canon));
}

// Normalise an application's submitted answer into an array of canonical tokens
// (MULTI_CHOICE answers carry an array; everything else a scalar).
function answerTokens(answerValue) {
  if (Array.isArray(answerValue)) return answerValue.map(canon);
  return [canon(answerValue)];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) scoreScreening(questions, answers) → { score, max, knockedOut, lines }
//    - points come from the matched ScreeningOption (CHOICE/QUALIFICATION), a
//      capped raw number (NUMBER), or 0 (TEXT/BOOLEAN have no intrinsic points
//      unless modelled as options).
//    - `max` is the best-possible points per question (the % denominator).
//    - KNOCKOUT: a required-pass question whose answer is NOT in knockoutValue →
//      knockedOut=true (terminal: the controller auto-rejects).
// ─────────────────────────────────────────────────────────────────────────────
function scoreScreening(questions, answers) {
  const qs = Array.isArray(questions) ? questions : [];
  const ans = Array.isArray(answers) ? answers : [];
  // index answers by questionId (last write wins for a re-answer)
  const byQ = new Map();
  for (const a of ans) byQ.set(a.questionId, a);

  let score = 0;
  let max = 0;
  let knockedOut = false;
  const lines = [];

  for (const q of qs) {
    const options = Array.isArray(q.options) ? q.options : [];
    const a = byQ.get(q.id);
    const hasAnswer = a !== undefined && a.answerValue !== undefined && a.answerValue !== null && a.answerValue !== '';

    // ── best-possible points for this question (the denominator contribution) ──
    let qMax = 0;
    if (q.kind === 'SINGLE_CHOICE' || q.kind === 'BOOLEAN' || q.kind === 'QUALIFICATION') {
      // best single option
      qMax = options.reduce((m, o) => Math.max(m, num(o.points)), 0);
    } else if (q.kind === 'MULTI_CHOICE') {
      // best case = sum of all positive option points (you could pick them all)
      qMax = options.reduce((m, o) => m + Math.max(0, num(o.points)), 0);
    } else if (q.kind === 'NUMBER') {
      qMax = num(q.maxPoints, 0);
    } else {
      qMax = 0; // TEXT / FILE — no auto points (an uploaded file has nothing to match)
    }
    if (q.maxPoints != null) qMax = Math.min(qMax, num(q.maxPoints));
    max += qMax;

    // ── awarded points for the actual answer ──
    let awarded = 0;
    let chosenLabel = null;
    if (hasAnswer) {
      const tokens = answerTokens(a.answerValue);
      if (q.kind === 'MULTI_CHOICE') {
        for (const o of options) {
          if (tokens.includes(canon(o.value))) awarded += num(o.points);
        }
      } else if (q.kind === 'SINGLE_CHOICE' || q.kind === 'BOOLEAN' || q.kind === 'QUALIFICATION') {
        const tok = tokens[0];
        const match = options.find((o) => canon(o.value) === tok);
        if (match) { awarded = num(match.points); chosenLabel = match.label; }
      } else if (q.kind === 'NUMBER') {
        awarded = num(a.answerValue);
      }
      if (q.maxPoints != null) awarded = Math.min(awarded, num(q.maxPoints));
      if (awarded < 0) awarded = 0;
    }

    // ── knockout evaluation ──
    let knockoutFailed = false;
    if (q.isKnockout) {
      const passSet = knockoutPassSet(q);
      if (!hasAnswer) {
        // an unanswered required knockout fails closed
        knockoutFailed = q.required !== false;
      } else {
        const tokens = answerTokens(a.answerValue);
        // pass if ANY answer token is in the pass set (and there is a pass set)
        const passed = passSet.size > 0 && tokens.some((t) => passSet.has(t));
        knockoutFailed = !passed;
      }
      if (knockoutFailed) knockedOut = true;
    }

    score += awarded;
    lines.push({
      questionId: q.id,
      q: q.prompt,
      awarded: round2(awarded),
      max: round2(qMax),
      label: chosenLabel,
      isKnockout: !!q.isKnockout,
      knockoutFailed,
      answered: hasAnswer,
    });
  }

  const koLines = lines.filter((l) => l.isKnockout);
  return {
    score: round2(score),
    max: round2(max),
    knockedOut,
    lines,
    knockouts: {
      total: koLines.length,
      failed: koLines.filter((l) => l.knockoutFailed).length,
      passed: koLines.filter((l) => !l.knockoutFailed).length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// per-scorecard weighted total → normalised 0–100.
//   weightedTotal = Σ(rescaled(score_i) * w_i) / Σ(w_i)
//   rescaled = (score - scaleMin) / (scaleMax - scaleMin) * 100, clamped 0–100.
// Defensive: Σweight=0 → equal weights; scaleMax<=scaleMin → 0.
// ─────────────────────────────────────────────────────────────────────────────
function weightedCardTotal(ratings) {
  const rs = Array.isArray(ratings) ? ratings.filter((r) => r != null) : [];
  if (rs.length === 0) return 0;
  let sumW = rs.reduce((s, r) => s + Math.max(0, num(r.weight, 1)), 0);
  const equal = sumW <= 0;
  let acc = 0;
  let wAcc = 0;
  for (const r of rs) {
    const w = equal ? 1 : Math.max(0, num(r.weight, 1));
    const lo = num(r.scaleMin, 1);
    const hi = num(r.scaleMax, 10);
    let pct;
    if (hi <= lo) pct = 0;
    else pct = ((num(r.score) - lo) / (hi - lo)) * 100;
    pct = Math.max(0, Math.min(100, pct));
    acc += pct * w;
    wAcc += w;
  }
  return wAcc > 0 ? round2(acc / wAcc) : 0;
}

// aggregate a list of per-interviewer totals per the configured mode.
function aggregate(totals, aggregation) {
  const xs = totals.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mode = aggregation || 'MEAN';
  if (mode === 'MAX') return round2(xs[xs.length - 1]);
  if (mode === 'MEDIAN') {
    const mid = Math.floor(xs.length / 2);
    return round2(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2);
  }
  if (mode === 'TRIMMED_MEAN' && xs.length >= 4) {
    const trimmed = xs.slice(1, -1); // drop top + bottom
    return round2(trimmed.reduce((s, n) => s + n, 0) / trimmed.length);
  }
  // MEAN (and TRIMMED_MEAN with <4 cards → falls back to MEAN)
  return round2(xs.reduce((s, n) => s + n, 0) / xs.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) scoreInterview(scorecards, { aggregation }) → { score, perInterviewer }
//    Only SUBMITTED cards with ratings count. Each card already carries a
//    persisted weightedTotal, but we recompute defensively from its ratings so a
//    re-score is always reproducible from the append-only rating ledger.
// ─────────────────────────────────────────────────────────────────────────────
function scoreInterview(scorecards, { aggregation = 'MEAN' } = {}) {
  const cards = (Array.isArray(scorecards) ? scorecards : [])
    .filter((c) => c && c.status === 'SUBMITTED');
  const perInterviewer = [];
  for (const c of cards) {
    const total = Array.isArray(c.ratings) && c.ratings.length
      ? weightedCardTotal(c.ratings)
      : num(c.weightedTotal, 0);
    perInterviewer.push({
      scorecardId: c.id || null,
      who: c.interviewerEmployeeId || null,
      total: round2(total),
      recommendation: c.recommendation || null,
    });
  }
  const score = aggregate(perInterviewer.map((p) => p.total), aggregation);
  return { score, perInterviewer, aggregation, interviewers: perInterviewer.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) computeMeritScore({ screeningScore, screeningMax, interviewScore, knockedOut },
//                      { applicationWeightPct, interviewWeightPct })
//    appPct = screeningMax>0 ? screening/max*100 : 0
//    merit  = aw/100 * appPct + iw/100 * interviewScore
//    Edge cases:
//      - knockedOut → merit 0 (flagged, never silently buried).
//      - no screening (max=0) → app contributes 0 and the blend RENORMALISES to
//        interview-only so the candidate is not unfairly capped.
//      - no submitted scorecards (interviewScore null) → merit reflects the
//        application portion only (renormalised), and `pending` is flagged.
// ─────────────────────────────────────────────────────────────────────────────
function computeMeritScore(parts, weights) {
  const screeningScore = num(parts.screeningScore, 0);
  const screeningMax = num(parts.screeningMax, 0);
  const interviewScore = parts.interviewScore == null ? null : num(parts.interviewScore, 0);
  const knockedOut = !!parts.knockedOut;

  let aw = num(weights && weights.applicationWeightPct, 40);
  let iw = num(weights && weights.interviewWeightPct, 60);

  const appPct = screeningMax > 0 ? round2((screeningScore / screeningMax) * 100) : 0;
  const hasApp = screeningMax > 0;
  const hasIv = interviewScore != null;

  // Renormalise the blend over only the components that are present, so a missing
  // component does not silently zero out the candidate's whole merit score.
  let effAw = hasApp ? aw : 0;
  let effIw = hasIv ? iw : 0;
  const sumEff = effAw + effIw;
  if (sumEff > 0) { effAw = (effAw / sumEff) * 100; effIw = (effIw / sumEff) * 100; }

  let merit = 0;
  if (sumEff > 0) {
    merit = (effAw / 100) * appPct + (effIw / 100) * (interviewScore || 0);
  }
  if (knockedOut) merit = 0;

  return {
    merit: round2(merit),
    breakdown: {
      formula: 'merit = app% * (screening/screeningMax*100) + iv% * interviewScore (renormalised over present components; knockout → 0)',
      applicationWeightPct: round2(aw),
      interviewWeightPct: round2(iw),
      effectiveApplicationWeightPct: round2(effAw),
      effectiveInterviewWeightPct: round2(effIw),
      appPct,
      interviewScore,
      knockedOut,
      interviewPending: !hasIv,
      screeningPending: !hasApp,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) recomputeApplicationScore(application, questions, answers, scorecards, job)
//    The orchestrator: produces the full scoreSnapshot JSON + the three persisted
//    decimals. Invoked on apply, scorecard submit, screening-answer edit, and the
//    manual "recompute" button. Pure → the merit number is always reproducible.
// ─────────────────────────────────────────────────────────────────────────────
function recomputeApplicationScore(application, questions, answers, scorecards, job) {
  const j = job || {};
  const screening = scoreScreening(questions, answers);

  const aggregation = (j.scorecardAggregation)
    || (scorecards && scorecards[0] && scorecards[0].aggregation)
    || 'MEAN';
  const interview = scoreInterview(scorecards, { aggregation });

  const weights = {
    applicationWeightPct: num(j.applicationWeightPct, 40),
    interviewWeightPct: num(j.interviewWeightPct, 60),
  };

  const merit = computeMeritScore({
    screeningScore: screening.score,
    screeningMax: screening.max,
    interviewScore: interview.score,
    knockedOut: screening.knockedOut,
  }, weights);

  const snapshot = {
    formula: merit.breakdown.formula,
    applicationWeightPct: weights.applicationWeightPct,
    interviewWeightPct: weights.interviewWeightPct,
    screening: {
      score: screening.score,
      max: screening.max,
      pct: merit.breakdown.appPct,
      lines: screening.lines.map((l) => ({ q: l.q, awarded: l.awarded, max: l.max, label: l.label, isKnockout: l.isKnockout, knockoutFailed: l.knockoutFailed })),
      knockouts: screening.knockouts,
      knockedOut: screening.knockedOut,
    },
    interview: {
      score: interview.score,
      interviewers: interview.interviewers,
      aggregation: interview.aggregation,
      pending: interview.score == null,
      perInterviewer: interview.perInterviewer,
    },
    merit: merit.merit,
    computedAt: new Date().toISOString(),
  };

  return {
    screeningScore: screening.score,
    screeningMaxScore: screening.max,
    knockedOut: screening.knockedOut,
    interviewScore: interview.score,
    meritScore: merit.merit,
    scoreSnapshot: snapshot,
  };
}

module.exports = {
  scoreScreening,
  scoreInterview,
  weightedCardTotal,
  aggregate,
  computeMeritScore,
  recomputeApplicationScore,
  _internals: { canon, knockoutPassSet, answerTokens, round2, num },
};
