'use strict';

/*
 * latePenalty.unit.test.js — Program P1.5 pure math. The policy: N free lates
 * per month, then every M further lates costs a day fraction ON the offending
 * day. Plain-node: node backend/src/hr/attendance/__tests__/latePenalty.unit.test.js
 */

const assert = require('assert');
const { computeLatePenalties } = require('../latePenalty');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

const late = (d) => ({ date: new Date(`2026-08-${String(d).padStart(2, '0')}T00:00:00Z`), lopFraction: 0, exceptionsJson: { flags: ['LATE_IN'] } });
const onTime = (d) => ({ date: new Date(`2026-08-${String(d).padStart(2, '0')}T00:00:00Z`), lopFraction: 0, exceptionsJson: { flags: [] } });
const rule = { allowedLatesPerMonth: 3, perLates: 1, penaltyDayFraction: 0.5, isActive: true };

/* 5 lates, 3 free, every 1 beyond → penalties on the 4th and 5th late days */
{
  const days = [late(3), onTime(4), late(5), late(10), late(17), late(24)];
  const p = computeLatePenalties(days, rule);
  ok('1st-3rd lates free', p.get('2026-08-03') === 0 && p.get('2026-08-05') === 0 && p.get('2026-08-10') === 0);
  ok('4th late penalised 0.5', p.get('2026-08-17') === 0.5);
  ok('5th late penalised 0.5', p.get('2026-08-24') === 0.5);
  ok('on-time day absent from map', !p.has('2026-08-04'));
}

/* perLates=3: only every 3rd late beyond the allowance costs */
{
  const days = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(late);
  const p = computeLatePenalties(days, { ...rule, perLates: 3 });
  ok('lates 4,5 free (block incomplete)', p.get('2026-08-04') === 0 && p.get('2026-08-05') === 0);
  ok('6th late (completes block of 3) penalised', p.get('2026-08-06') === 0.5);
  ok('9th late penalised', p.get('2026-08-09') === 0.5);
  ok('7th,8th free', p.get('2026-08-07') === 0 && p.get('2026-08-08') === 0);
}

/* allowance 0 → every perLates-th late from the first */
{
  const p = computeLatePenalties([late(1), late(2)], { ...rule, allowedLatesPerMonth: 0 });
  ok('zero allowance: 1st late penalised', p.get('2026-08-01') === 0.5 && p.get('2026-08-02') === 0.5);
}

/* order independence: rows arrive unsorted */
{
  const p = computeLatePenalties([late(24), late(3), late(17), late(5), late(10)], rule);
  ok('unsorted input: chronological 4th/5th penalised', p.get('2026-08-17') === 0.5 && p.get('2026-08-24') === 0.5 && p.get('2026-08-03') === 0);
}

/* inactive / missing rule → empty */
{
  ok('inactive rule → no penalties', computeLatePenalties([late(1)], { ...rule, isActive: false }).size === 0);
  ok('no rule → no penalties', computeLatePenalties([late(1)], null).size === 0);
}

/* full-day fraction */
{
  const p = computeLatePenalties([late(1), late(2), late(3), late(4)], { ...rule, penaltyDayFraction: 1 });
  ok('full-day penalty', p.get('2026-08-04') === 1);
}

console.log(`latePenalty.unit: ${passed} checks passed`);
