'use strict';

/*
 * quizScoring.unit.test.js — PURE unit test for the LMS quiz scorer (Feature 37).
 * No DB. Plain-node runner:  node src/hr/talent/learning/__tests__/quizScoring.unit.test.js
 */

const { score } = require('../quizScoring');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

log('quizScoring — pure scorer');

// SINGLE — exact one-option match.
const single = [{ id: 'q1', kind: 'SINGLE', correctOptionIds: ['a'], points: 1 }];
assert(score({ questions: single, answers: { q1: ['a'] }, passThreshold: 70 }).scorePct === 100, 'SINGLE correct → 100%');
assert(score({ questions: single, answers: { q1: ['b'] }, passThreshold: 70 }).scorePct === 0, 'SINGLE wrong → 0%');
assert(score({ questions: single, answers: { q1: ['a', 'b'] }, passThreshold: 70 }).scorePct === 0, 'SINGLE extra pick → 0% (not exact)');

// MULTI — all-correct-and-no-incorrect.
const multi = [{ id: 'q1', kind: 'MULTI', correctOptionIds: ['a', 'c'], points: 1 }];
assert(score({ questions: multi, answers: { q1: ['a', 'c'] } }).scorePct === 100, 'MULTI exact set → 100%');
assert(score({ questions: multi, answers: { q1: ['c', 'a'] } }).scorePct === 100, 'MULTI order-independent → 100%');
assert(score({ questions: multi, answers: { q1: ['a'] } }).scorePct === 0, 'MULTI partial → 0% (no partial credit v1)');
assert(score({ questions: multi, answers: { q1: ['a', 'b', 'c'] } }).scorePct === 0, 'MULTI with an incorrect → 0%');

// Points-weighted score + pass threshold.
const weighted = [
  { id: 'q1', kind: 'SINGLE', correctOptionIds: ['a'], points: 3 },
  { id: 'q2', kind: 'SINGLE', correctOptionIds: ['x'], points: 1 },
];
const r = score({ questions: weighted, answers: { q1: ['a'], q2: ['y'] }, passThreshold: 70 });
assert(r.scorePct === 75, 'weighted: 3/4 points → 75%');
assert(r.passed === true, 'weighted: 75% ≥ 70% → passed');
assert(score({ questions: weighted, answers: { q2: ['x'] }, passThreshold: 70 }).passed === false, 'weighted: 1/4 → fail');

// Edge: empty quiz / no key.
assert(score({ questions: [], answers: {} }).scorePct === 0, 'empty quiz → 0%, not passed');
assert(score({ questions: [{ id: 'q', kind: 'SINGLE', correctOptionIds: [], points: 1 }], answers: { q: [] } }).passed === false, 'no answer key → never correct');

log(failures ? `\nFAIL ${failures} assertion(s)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
