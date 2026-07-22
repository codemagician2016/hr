'use strict';

/*
 * leaderboard.unit.test.js — Feature 35 pure leaderboard derivation (§4.6).
 * Plain-node, no DB: node backend/src/hr/recognition/__tests__/leaderboard.unit.test.js
 */

const assert = require('assert');
const { windowRange, rankEarners, rankGivers, valueTally } = require('../leaderboard');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

/* ── windowRange ── */
{
  const m = windowRange('month', new Date(2026, 6, 21));
  ok('month window start', m.start.getTime() === new Date(2026, 6, 1).getTime());
  ok('month window end', m.end.getTime() === new Date(2026, 7, 1).getTime());

  const q = windowRange('quarter', new Date(2026, 0, 2)); // Jan → Q1
  ok('quarter window', q.start.getTime() === new Date(2026, 0, 1).getTime() && q.end.getTime() === new Date(2026, 3, 1).getTime());

  const a = windowRange('allTime');
  ok('allTime is unbounded', a.start === null && a.end === null);
  ok("'all' alias works", windowRange('all').start === null);
  ok('unknown period defaults to month', windowRange('??', new Date(2026, 2, 3)).start.getMonth() === 2);
}

/* ── rankEarners: earned-only (RECOGNITION/AWARD, +points) ── */
const e = (employeeId, points, reason = 'RECOGNITION') => ({ employeeId, points, reason });
{
  const ranked = rankEarners([
    e('a', 50), e('a', 30), e('b', 100, 'AWARD'), e('c', 10),
    e('a', -20, 'REDEMPTION'),   // spends never dent the board
    e('c', 500, 'ADJUSTMENT'),   // manual grants don't game the board
    e('b', -100, 'EXPIRY'),      // expiry doesn't dent the board
    e('d', 0),                   // zero rows ignored
  ]);
  const byId = Object.fromEntries(ranked.map((r) => [r.employeeId, r]));
  ok('sums only RECOGNITION/AWARD credits', byId.a.points === 80 && byId.b.points === 100 && byId.c.points === 10);
  ok('zero-point employee not listed', !byId.d);
  ok('sorted desc', ranked[0].employeeId === 'b' && ranked[1].employeeId === 'a' && ranked[2].employeeId === 'c');
  ok('ranks assigned', ranked[0].rank === 1 && ranked[1].rank === 2 && ranked[2].rank === 3);
}

/* ties share a rank; the next rank skips (competition ranking) */
{
  const ranked = rankEarners([e('a', 100), e('b', 100), e('c', 50), e('d', 50), e('x', 200)]);
  const byId = Object.fromEntries(ranked.map((r) => [r.employeeId, r]));
  ok('leader is rank 1', byId.x.rank === 1);
  ok('tied pair shares rank 2', byId.a.rank === 2 && byId.b.rank === 2);
  ok('next after a tie skips (rank 4)', byId.c.rank === 4 && byId.d.rank === 4);
}

/* junk rows are ignored */
{
  const ranked = rankEarners([null, { points: 5 }, e('a', 'x'), e('a', 2.5), e('a', 10)]);
  ok('junk filtered, valid summed', ranked.length === 1 && ranked[0].points === 10);
  ok('empty input → empty board', rankEarners([]).length === 0);
}

/* ── rankGivers: POSTED-only counts ── */
const g = (giverEmployeeId, status = 'POSTED') => ({ giverEmployeeId, status });
{
  const ranked = rankGivers([
    g('a'), g('a'), g('a'), g('b'), g('b'),
    g('b', 'PENDING_APPROVAL'), // pending doesn't count
    g('c', 'REJECTED'),         // rejected doesn't count
  ]);
  const byId = Object.fromEntries(ranked.map((r) => [r.employeeId, r]));
  ok('giver counts POSTED only', byId.a.count === 3 && byId.b.count === 2 && !byId.c);
  ok('givers sorted + ranked', ranked[0].employeeId === 'a' && ranked[0].rank === 1 && byId.b.rank === 2);
  ok('missing status counts (pre-loaded rows)', rankGivers([{ giverEmployeeId: 'z' }])[0].count === 1);
}

/* ── valueTally: most-celebrated value ── */
const v = (valueId, status = 'POSTED') => ({ valueId, status });
{
  const tally = valueTally([
    v('cust'), v('cust'), v('own'),
    v(null),              // untagged gives don't tally
    v('cust', 'REJECTED'), // rejected doesn't tally
  ]);
  const byId = Object.fromEntries(tally.map((r) => [r.valueId, r]));
  ok('value counts', byId.cust.count === 2 && byId.own.count === 1);
  ok('value ranks', byId.cust.rank === 1 && byId.own.rank === 2);
  ok('null valueId ignored', tally.length === 2);
}

console.log(`leaderboard.unit: ${passed} checks passed`);
