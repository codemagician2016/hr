'use strict';

/*
 * enps.unit.test.js — Feature 33 pure eNPS + aggregation math (§5.3, §6.3, §9).
 * Plain-node, no DB: node backend/src/hr/engagement/surveys/__tests__/enps.unit.test.js
 */

const assert = require('assert');
const { classifyNps, computeEnps, aggregateQuestion, segmentBreakdown } = require('../enps');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

/* ── classifyNps boundaries ── */
{
  ok('0 is DETRACTOR', classifyNps(0) === 'DETRACTOR');
  ok('6 is DETRACTOR (boundary)', classifyNps(6) === 'DETRACTOR');
  ok('7 is PASSIVE (boundary)', classifyNps(7) === 'PASSIVE');
  ok('8 is PASSIVE (boundary)', classifyNps(8) === 'PASSIVE');
  ok('9 is PROMOTER (boundary)', classifyNps(9) === 'PROMOTER');
  ok('10 is PROMOTER', classifyNps(10) === 'PROMOTER');
  ok('non-numeric → null', classifyNps('x') === null && classifyNps(null) === null);
}

/* ── computeEnps math ── */
{
  const e = computeEnps([10, 10, 9, 8, 7, 0, 3], 1);
  ok('promoters counted', e.promoters === 3);
  ok('passives counted (reported, excluded from subtraction)', e.passives === 2);
  ok('detractors counted', e.detractors === 2);
  ok('total counted', e.total === 7);
  ok('enps = round(pP − pD) = 14', e.enps === 14); // 42.857 − 28.571 = 14.29 → 14
  ok('promoterPct rounded to 1dp', e.promoterPct === 42.9);
  ok('detractorPct rounded to 1dp', e.detractorPct === 28.6);
}

/* rounding uses UNROUNDED pcts (16.667 → 17, not 16.6−… display drift) */
{
  const e = computeEnps([9, 9, 0, 7, 7, 7], 1);
  ok('rounding: 33.33−16.67 → 17', e.enps === 17);
}

/* bounds −100…+100 */
{
  ok('all promoters → +100', computeEnps([10, 9, 10], 1).enps === 100);
  ok('all detractors → −100', computeEnps([0, 1, 6], 1).enps === -100);
}

/* zero net */
{
  const e = computeEnps([10, 0], 1);
  ok('balanced promoters/detractors → 0', e.enps === 0);
}

/* invalid scores are filtered, never counted */
{
  const e = computeEnps([11, -1, 5.5, 'x', 9, 0], 1);
  ok('out-of-range/non-integer filtered', e.total === 2 && e.promoters === 1 && e.detractors === 1);
}

/* empty + below-k suppression: NO numbers on a suppressed result */
{
  ok('empty → suppressed', computeEnps([], 1).suppressed === true);
  const s = computeEnps([9, 9, 9, 9], 5);
  ok('below-k (4 < 5) → suppressed', s.suppressed === true);
  ok('suppressed result carries no numbers', s.enps === undefined && s.total === undefined && s.promoters === undefined);
  ok('exactly-k shows', computeEnps([9, 9, 9, 9, 9], 5).enps === 100);
}

/* §9 invariant sweep: enps == round(pP − pD); classes partition total; bounds hold */
{
  const cases = [
    [9, 9, 9, 0, 0, 7], [10, 8, 8, 8, 6], [0, 10, 5, 7, 9, 9, 3, 8],
    [7, 7, 7, 7], [10], [6], [9, 6, 9, 6, 9, 6, 8],
  ];
  for (const scores of cases) {
    const e = computeEnps(scores, 1);
    ok(`invariant partition [${scores}]`, e.promoters + e.passives + e.detractors === e.total);
    ok(`invariant enps formula [${scores}]`, e.enps === Math.round(((e.promoters - e.detractors) / e.total) * 100));
    ok(`invariant bounds [${scores}]`, e.enps >= -100 && e.enps <= 100 && Number.isInteger(e.enps));
  }
}

/* ── aggregateQuestion per type ── */
/* SCALE — mean + distribution histogram over scaleMin..scaleMax */
{
  const q = { type: 'SCALE', scaleMin: 1, scaleMax: 5 };
  const a = [5, 4, 4, 3, 1].map((v) => ({ numericValue: v }));
  const agg = aggregateQuestion(q, a, { k: 5 });
  ok('SCALE count', agg.count === 5);
  ok('SCALE mean', agg.mean === 3.4);
  const dist = Object.fromEntries(agg.distribution.map((d) => [d.value, d.count]));
  ok('SCALE distribution buckets', dist[1] === 1 && dist[2] === 0 && dist[3] === 1 && dist[4] === 2 && dist[5] === 1);
  ok('SCALE below-k suppressed', aggregateQuestion(q, a.slice(0, 4), { k: 5 }).suppressed === true);
}

/* LIKERT rides the SCALE path */
{
  const agg = aggregateQuestion({ type: 'LIKERT', scaleMin: 1, scaleMax: 5 }, [{ numericValue: 2 }, { numericValue: 4 }], { k: 2 });
  ok('LIKERT mean', agg.mean === 3 && agg.count === 2);
}

/* NPS — delegates to computeEnps */
{
  const q = { type: 'NPS', scaleMin: 0, scaleMax: 10 };
  const a = [10, 9, 8, 0, 6].map((v) => ({ numericValue: v }));
  const agg = aggregateQuestion(q, a, { k: 5 });
  ok('NPS enps computed', agg.enps === 0 && agg.promoters === 2 && agg.detractors === 2 && agg.passives === 1);
  ok('NPS below-k suppressed', aggregateQuestion(q, a.slice(0, 3), { k: 5 }).suppressed === true);
}

/* SINGLE — per-option counts + pct */
{
  const q = { type: 'SINGLE', options: [{ value: 'y', label: 'Yes' }, { value: 'n', label: 'No' }] };
  const a = [['y'], ['y'], ['n'], ['y'], ['n']].map((c) => ({ choiceValues: c }));
  const agg = aggregateQuestion(q, a, { k: 5 });
  const byVal = Object.fromEntries(agg.options.map((o) => [o.value, o]));
  ok('SINGLE counts', byVal.y.count === 3 && byVal.n.count === 2);
  ok('SINGLE pcts', byVal.y.pct === 60 && byVal.n.pct === 40);
  ok('SINGLE respondent count', agg.count === 5);
}

/* MULTI — multi-select counts + "Other" counted but its text NOT surfaced */
{
  const q = { type: 'MULTI', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], allowOther: true };
  const a = [
    { choiceValues: ['a', 'b'] }, { choiceValues: ['a'] },
    { choiceValues: [], textValue: 'something else' },
    { choiceValues: ['b'] }, { choiceValues: ['a'] },
  ];
  const agg = aggregateQuestion(q, a, { k: 5 });
  const byVal = Object.fromEntries(agg.options.map((o) => [o.value, o]));
  ok('MULTI counts', byVal.a.count === 3 && byVal.b.count === 2);
  ok('MULTI other counted, text hidden', agg.otherCount === 1 && !JSON.stringify(agg).includes('something else'));
}

/* TEXT — count ONLY, never contents */
{
  const q = { type: 'TEXT' };
  const a = [{ textValue: 'great place' }, { textValue: '   ' }, { textValue: 'more chai' }];
  const agg = aggregateQuestion(q, a, { k: 2 });
  ok('TEXT counts non-empty only', agg.count === 2);
  ok('TEXT contents never in aggregate', !JSON.stringify(agg).includes('great place'));
  ok('TEXT below-k suppressed', aggregateQuestion(q, a.slice(0, 1), { k: 2 }).suppressed === true);
}

/* ── segmentBreakdown — k-suppression + the complement-leak guard (§6.3) ── */
const rows = (label, n) => Array.from({ length: n }, () => ({ segmentLabel: label }));

/* all groups ≥ k → all shown, none suppressed */
{
  const out = segmentBreakdown([...rows('Eng', 6), ...rows('Sales', 5), ...rows('HR', 5)], 'DEPARTMENT', 5);
  ok('no suppression when all ≥ k', out.groups.length === 3 && out.suppressedGroups === 0);
  ok('dimension echoed', out.dimension === 'DEPARTMENT');
  ok('groups sorted biggest-first', out.groups[0].label === 'Eng' && out.groups[0].count === 6);
}

/* THE complement guard: exactly one below-k group → the next-smallest is hidden too */
{
  const out = segmentBreakdown([...rows('Eng', 10), ...rows('Sales', 7), ...rows('HR', 3)], 'DEPARTMENT', 5);
  ok('guard: only Eng survives', out.groups.length === 1 && out.groups[0].label === 'Eng');
  ok('guard: TWO groups suppressed (HR + next-smallest Sales)', out.suppressedGroups === 2);
  const s = JSON.stringify(out);
  ok('guard: hidden labels never leak', !s.includes('HR') && !s.includes('Sales'));
}

/* two below-k groups → both hidden, NO extra suppression */
{
  const out = segmentBreakdown([...rows('Eng', 10), ...rows('Sales', 4), ...rows('HR', 3)], 'DEPARTMENT', 5);
  ok('two small groups hidden, big one shown', out.groups.length === 1 && out.suppressedGroups === 2);
}

/* everything below k → nothing shown */
{
  const out = segmentBreakdown([...rows('A', 2), ...rows('B', 1)], 'DEPARTMENT', 5);
  ok('all below k → no groups', out.groups.length === 0 && out.suppressedGroups === 2);
}

/* single tiny group → hidden alone (nothing shown → no complement to back-compute) */
{
  const out = segmentBreakdown(rows('A', 3), 'DEPARTMENT', 5);
  ok('lone small group hidden, nothing rendered', out.groups.length === 0 && out.suppressedGroups === 1);
}

/* null/empty labels bucket as "Unassigned" and follow the same rules */
{
  const out = segmentBreakdown([...rows(null, 5), ...rows('Eng', 6)], 'DEPARTMENT', 5);
  const labels = out.groups.map((g) => g.label).sort();
  ok('null label → Unassigned bucket', labels.join(',') === 'Eng,Unassigned' && out.suppressedGroups === 0);
}

/* computeGroup aggregates merge into shown groups only */
{
  const data = [
    ...rows('Eng', 6).map((r, i) => ({ ...r, score: i })),
    ...rows('HR', 6).map((r, i) => ({ ...r, score: i + 10 })),
  ];
  const out = segmentBreakdown(data, 'DEPARTMENT', 5, (grp) => ({ maxScore: Math.max(...grp.map((g) => g.score)) }));
  const byLabel = Object.fromEntries(out.groups.map((g) => [g.label, g]));
  ok('computeGroup merged per group', byLabel.Eng.maxScore === 5 && byLabel.HR.maxScore === 15);
}

/* §9 invariants over a sweep of shapes: every rendered group ≥ k; never exactly one
 * suppressed while any group is rendered (the complement guard) */
{
  const shapes = [
    [['A', 12], ['B', 6], ['C', 4]],
    [['A', 5], ['B', 5], ['C', 5], ['D', 1]],
    [['A', 20], ['B', 2]],
    [['A', 4], ['B', 4], ['C', 4]],
    [['A', 9]],
    [['A', 5], ['B', 4], ['C', 3], ['D', 2]],
  ];
  for (const shape of shapes) {
    const data = shape.flatMap(([l, n]) => rows(l, n));
    const out = segmentBreakdown(data, 'DEPARTMENT', 5);
    ok(`invariant rendered≥k ${JSON.stringify(shape)}`, out.groups.every((g) => g.count >= 5));
    ok(`invariant complement ${JSON.stringify(shape)}`, !(out.suppressedGroups === 1 && out.groups.length > 0));
  }
}

console.log(`enps.unit: ${passed} checks passed`);
