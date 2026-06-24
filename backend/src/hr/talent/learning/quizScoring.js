'use strict';

/**
 * quizScoring.js — PURE quiz scorer (Feature 37 LMS). No DB, no I/O — mirrors the
 * performance/proration.js purity convention so it is trivially unit-testable.
 *
 * The answer key (`correctOptionIds`) lives on the server-side QuizQuestion only and
 * NEVER leaves the server (the ESS serializer strips it). Scoring runs here on submit.
 *
 *   score({ questions, answers, passThreshold }) -> { scorePct, passed, perQuestion[] }
 *
 * Grading rules (v1, partial-credit OFF):
 *   SINGLE / TRUE_FALSE — correct iff the chosen set is EXACTLY the one correct option.
 *   MULTI               — correct iff the chosen set equals the correct set
 *                         (all-correct-and-no-incorrect). Order-independent.
 * Score is points-weighted: scorePct = round(100 * earnedPoints / totalPoints).
 * An empty quiz (no questions / zero total points) scores 0 and does not pass.
 */

function toSet(arr) {
  return new Set(Array.isArray(arr) ? arr.filter((x) => x != null).map(String) : []);
}

function setEquals(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * @param {Object} args
 * @param {Array}  args.questions  [{ id, kind, correctOptionIds:string[], points }]
 * @param {Object} args.answers    { [questionId]: string[] (chosen option ids) }
 * @param {number} args.passThreshold  percent (0..100) required to pass
 * @returns {{ scorePct:number, passed:boolean, earnedPoints:number, totalPoints:number,
 *            perQuestion: Array<{ questionId:string, correct:boolean, points:number }> }}
 */
function score({ questions, answers, passThreshold = 70 } = {}) {
  const qs = Array.isArray(questions) ? questions : [];
  const ans = answers && typeof answers === 'object' ? answers : {};

  let earnedPoints = 0;
  let totalPoints = 0;
  const perQuestion = [];

  for (const q of qs) {
    const pts = Number.isFinite(q.points) && q.points > 0 ? q.points : 1;
    totalPoints += pts;
    const correctSet = toSet(q.correctOptionIds);
    const chosenSet = toSet(ans[q.id]);
    // SINGLE/MULTI/TRUE_FALSE all collapse to "exact set match" in v1 (no partial credit).
    const isCorrect = correctSet.size > 0 && setEquals(chosenSet, correctSet);
    if (isCorrect) earnedPoints += pts;
    perQuestion.push({ questionId: q.id, correct: isCorrect, points: pts });
  }

  const scorePct = totalPoints > 0 ? Math.round((100 * earnedPoints) / totalPoints) : 0;
  const passed = totalPoints > 0 && scorePct >= Number(passThreshold || 0);
  return { scorePct, passed, earnedPoints, totalPoints, perQuestion };
}

module.exports = { score, _internals: { toSet, setEquals } };
