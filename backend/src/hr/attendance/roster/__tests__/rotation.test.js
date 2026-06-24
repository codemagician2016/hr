'use strict';

/*
 * rotation.test.js — PURE unit test for the Feature 29 rotation generator
 * (../rotation.js). Plain-node (built-in assert, no jest):
 *   node backend/src/hr/attendance/roster/__tests__/rotation.test.js
 *
 * Proves: ring index math across the anchor (incl. negative/before-anchor + wrap),
 * phase offsets, OFF slots → OFF rows, the 11-hour rest violation, the night-shift
 * consent gate (skip + flag), unresolved-shift handling, mid-cycle hire/exit.
 */

const assert = require('assert');
const { generateRoster, _internals } = require('../rotation.js');

let passed = 0;
let failed = 0;
const fails = [];
function check(name, cond) {
  if (cond) { passed += 1; } else { failed += 1; fails.push(name); }
}
function eq(name, a, b) { check(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b)); }

// ── fixtures ─────────────────────────────────────────────────────────────────
const patterns = new Map([
  ['M', { id: 'M', startTime: '06:00', endTime: '14:00', isNightShift: false }],
  ['A', { id: 'A', startTime: '14:00', endTime: '22:00', isNightShift: false }],
  ['N', { id: 'N', startTime: '22:00', endTime: '06:00', isNightShift: true }],
]);

// The classic factory 6-1-6-1-6-2 ring = 22 slots.
function factoryRing() {
  const slots = [];
  for (let i = 0; i < 6; i++) slots.push({ kind: 'WORK', shiftPatternId: 'M' });
  slots.push({ kind: 'OFF' });
  for (let i = 0; i < 6; i++) slots.push({ kind: 'WORK', shiftPatternId: 'A' });
  slots.push({ kind: 'OFF' });
  for (let i = 0; i < 6; i++) slots.push({ kind: 'WORK', shiftPatternId: 'N' });
  slots.push({ kind: 'OFF' });
  slots.push({ kind: 'OFF' });
  return { id: 'T', slotsJson: slots, cycleLength: 22, anchorDate: '2026-07-01' };
}

// ── 1. cycle: a 22-day window from the anchor materialises the full ring ──────
{
  const r = generateRoster(factoryRing(), [{ employeeId: 'e1', nightShiftEligible: true }], '2026-07-01', '2026-07-22', { shiftPatterns: patterns });
  eq('cycle row count', r.rows.length, 22);
  eq('cycle no violations', r.violations.length, 0);
  eq('day0 = WORK M', [r.rows[0].dayType, r.rows[0].shiftPatternId], ['WORK', 'M']);
  eq('day6 = OFF', r.rows[6].dayType, 'OFF');
  eq('day7 = A', r.rows[7].shiftPatternId, 'A');
  eq('day13 = OFF', r.rows[13].dayType, 'OFF');
  eq('day19 = N (last night)', r.rows[19].shiftPatternId, 'N');
  eq('day20 = OFF', r.rows[20].dayType, 'OFF');
  eq('day21 = OFF', r.rows[21].dayType, 'OFF');
}

// ── 2. wrap: day 22 wraps to slot 0 (M) ──────────────────────────────────────
{
  const r = generateRoster(factoryRing(), [{ employeeId: 'e1', nightShiftEligible: true }], '2026-07-23', '2026-07-23', { shiftPatterns: patterns });
  eq('wrap day22 = M', [r.rows[0].dayType, r.rows[0].shiftPatternId], ['WORK', 'M']);
}

// ── 3. phase offset staggers a second team ───────────────────────────────────
{
  const r = generateRoster(factoryRing(), [{ employeeId: 'eB', phaseOffset: 7, nightShiftEligible: true }], '2026-07-01', '2026-07-01', { shiftPatterns: patterns });
  eq('phase 7 → slot 7 = A', r.rows[0].shiftPatternId, 'A');
}

// ── 4. before-anchor dates land on the right ring slot (negative daysBetween) ─
{
  // anchor day -1 → slot index (((-1)%22)+22)%22 = 21 = OFF (the 2nd of the 2-OFF).
  const r = generateRoster(factoryRing(), [{ employeeId: 'e1', nightShiftEligible: true }], '2026-06-30', '2026-06-30', { shiftPatterns: patterns });
  eq('anchor-1 = OFF (slot 21)', r.rows[0].dayType, 'OFF');
}

// ── 5. night-consent gate: non-consenting employee skips N + collects a flag ──
{
  const r = generateRoster(factoryRing(), [{ employeeId: 'e2', nightShiftEligible: false }], '2026-07-01', '2026-07-22', { shiftPatterns: patterns });
  const nc = r.violations.filter((v) => v.code === 'NIGHT_CONSENT');
  eq('6 NIGHT_CONSENT flags', nc.length, 6);
  eq('night rows skipped → 16 rows', r.rows.length, 16);
  check('no N row emitted', !r.rows.some((x) => x.shiftPatternId === 'N'));
}

// ── 5b. overrideNightConsent emits the night rows anyway (still flagged) ──────
{
  const r = generateRoster(factoryRing(), [{ employeeId: 'e2', nightShiftEligible: false }], '2026-07-01', '2026-07-22', { shiftPatterns: patterns, overrideNightConsent: true });
  eq('override → all 22 rows', r.rows.length, 22);
  eq('override still flags 6', r.violations.filter((v) => v.code === 'NIGHT_CONSENT').length, 6);
}

// ── 6. 11h rest violation: N (ends 06:00 next day) → M (starts 06:00) = 0h ─────
{
  const ring = { id: 'T2', slotsJson: [{ kind: 'WORK', shiftPatternId: 'N' }, { kind: 'WORK', shiftPatternId: 'M' }], cycleLength: 2, anchorDate: '2026-07-01' };
  const r = generateRoster(ring, [{ employeeId: 'e3', nightShiftEligible: true }], '2026-07-01', '2026-07-02', { shiftPatterns: patterns });
  const rv = r.violations.find((v) => v.code === 'REST_VIOLATION');
  check('REST_VIOLATION raised', !!rv);
  eq('rest minutes = 0', rv && rv.restMinutes, 0);
}

// ── 6b. adequate rest does NOT flag: M (ends 14:00) → A next day (starts 14:00)=24h
{
  const ring = { id: 'T3', slotsJson: [{ kind: 'WORK', shiftPatternId: 'M' }, { kind: 'WORK', shiftPatternId: 'A' }], cycleLength: 2, anchorDate: '2026-07-01' };
  const r = generateRoster(ring, [{ employeeId: 'e4', nightShiftEligible: true }], '2026-07-01', '2026-07-02', { shiftPatterns: patterns });
  eq('no rest violation (24h apart)', r.violations.filter((v) => v.code === 'REST_VIOLATION').length, 0);
}

// ── 7. unresolved WORK slot → UNRESOLVED_SHIFT, row skipped ───────────────────
{
  const ring = { id: 'T4', slotsJson: [{ kind: 'WORK', shiftPatternId: 'GHOST' }], cycleLength: 1, anchorDate: '2026-07-01' };
  const r = generateRoster(ring, [{ employeeId: 'e5', nightShiftEligible: true }], '2026-07-01', '2026-07-01', { shiftPatterns: patterns });
  eq('UNRESOLVED_SHIFT flagged', r.violations.filter((v) => v.code === 'UNRESOLVED_SHIFT').length, 1);
  eq('no row emitted', r.rows.length, 0);
}

// ── 8. mid-cycle hire/exit truncates the population window (E4) ───────────────
{
  const r = generateRoster(factoryRing(), [{ employeeId: 'e6', nightShiftEligible: true, joinDate: '2026-07-03', exitDate: '2026-07-05' }], '2026-07-01', '2026-07-22', { shiftPatterns: patterns });
  eq('hire/exit → 3 rows (Jul3..Jul5)', r.rows.length, 3);
  eq('first row date = join', r.rows[0].date, '2026-07-03');
  eq('last row date = exit', r.rows[2].date, '2026-07-05');
}

// ── 9. determinism: same inputs → identical rows ─────────────────────────────
{
  const a = generateRoster(factoryRing(), [{ employeeId: 'e1', nightShiftEligible: true }], '2026-07-01', '2026-07-22', { shiftPatterns: patterns });
  const b = generateRoster(factoryRing(), [{ employeeId: 'e1', nightShiftEligible: true }], '2026-07-01', '2026-07-22', { shiftPatterns: patterns });
  eq('deterministic', a.rows, b.rows);
}

// ── 10. internals: restMinutesBetween across the boundary ─────────────────────
{
  // N ends 06:00 (next day) → A starts 14:00 same next day = 8h = 480m.
  const rest = _internals.restMinutesBetween('2026-07-01', patterns.get('N'), '2026-07-02', patterns.get('A'));
  eq('N→next-A rest = 480m', rest, 480);
}

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\nrotation unit: ${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILURES:\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
console.log('=== ALL ROTATION UNIT TESTS PASSED ===');
