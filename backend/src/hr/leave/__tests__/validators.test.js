'use strict';

/*
 * validators.test.js — INDEPENDENT QA for the pre-apply policy gates
 * (../validators.js). Plain-node:
 *   node backend/src/hr/leave/__tests__/validators.test.js
 *
 * Covers QA 7 (negative-balance guard) + QA 8 (overlap/notice/eligibility) —
 * each reason code fires on its boundary.
 */

const assert = require('assert');
const V = require('../validators.js');

let passed = 0; let failed = 0; const fails = [];
function codesOf(res) { return res.errors.map((e) => e.code).sort(); }
function has(name, res, code) {
  const ok = res.errors.some((e) => e.code === code);
  if (ok) passed++; else { failed++; fails.push({ name, want: code, got: codesOf(res) }); }
}
function lacks(name, res, code) {
  const ok = !res.errors.some((e) => e.code === code);
  if (ok) passed++; else { failed++; fails.push({ name, notWant: code, got: codesOf(res) }); }
}
function check(name, expected, actual) {
  let ok; try { assert.deepStrictEqual(actual, expected); ok = true; } catch (_) { ok = false; }
  if (ok) passed++; else { failed++; fails.push({ name, expected, actual }); }
}

const NOW = '2026-06-01';
const base = {
  request: { startDate: '2026-06-10', endDate: '2026-06-12' },
  units: 3, consecutiveDays: 3, asOf: NOW,
  policy: {}, leaveType: { category: 'ANNUAL' },
  balance: { closing: 10, pendingApproval: 0 },
  employee: { hireDate: '2020-01-01' },
  overlapping: [],
};

// ── happy path ────────────────────────────────────────────────────────────────
check('0 happy path ok', true, V.validateRequest(base).ok);

// ── INSUFFICIENT_BALANCE ──────────────────────────────────────────────────────
has('1 insufficient balance',
  V.validateRequest({ ...base, units: 12 }), 'INSUFFICIENT_BALANCE');
lacks('1b sufficient balance no code',
  V.validateRequest({ ...base, units: 10 }), 'INSUFFICIENT_BALANCE');

// ── advance / negativeCap ─────────────────────────────────────────────────────
// allowNegative within cap: closing 0, request 3, cap 5 → ok
const advOk = V.validateRequest({
  ...base, units: 3, balance: { closing: 0, pendingApproval: 0 },
  policy: { allowNegative: true, negativeCap: 5 },
});
lacks('2 advance within cap ok', advOk, 'NEGATIVE_CAP_EXCEEDED');
lacks('2b advance within cap not flagged insufficient', advOk, 'INSUFFICIENT_BALANCE');
// beyond cap: closing 0, request 8, cap 5 → projected -8 < -5 → fail
has('3 advance beyond negativeCap',
  V.validateRequest({ ...base, units: 8, balance: { closing: 0, pendingApproval: 0 }, policy: { allowNegative: true, negativeCap: 5 } }),
  'NEGATIVE_CAP_EXCEEDED');

// ── NOTICE_TOO_SHORT ──────────────────────────────────────────────────────────
// minNotice 7, start 06-03 (only 2 days notice) → fail
has('4 notice too short',
  V.validateRequest({ ...base, request: { startDate: '2026-06-03', endDate: '2026-06-03' }, units: 1, policy: { minNoticeDays: 7 } }),
  'NOTICE_TOO_SHORT');
// enough notice (start 06-10, 9 days) → ok
lacks('4b notice met',
  V.validateRequest({ ...base, request: { startDate: '2026-06-10', endDate: '2026-06-10' }, units: 1, policy: { minNoticeDays: 7 } }),
  'NOTICE_TOO_SHORT');
// SICK can back-date even with notice policy
lacks('4c SICK back-date allowed',
  V.validateRequest({ ...base, request: { startDate: '2026-05-30', endDate: '2026-05-30' }, units: 1, leaveType: { category: 'SICK' }, policy: { minNoticeDays: 7 } }),
  'NOTICE_TOO_SHORT');
// ANNUAL cannot back-date
has('4d ANNUAL back-date blocked',
  V.validateRequest({ ...base, request: { startDate: '2026-05-30', endDate: '2026-05-30' }, units: 1, leaveType: { category: 'ANNUAL' }, policy: { minNoticeDays: 7 } }),
  'NOTICE_TOO_SHORT');
// HR override bypasses notice
lacks('4e HR override bypasses notice',
  V.validateRequest({ ...base, request: { startDate: '2026-06-03', endDate: '2026-06-03' }, units: 1, policy: { minNoticeDays: 7 }, hrOverride: true }),
  'NOTICE_TOO_SHORT');

// ── EXCEEDS_MAX_CONSECUTIVE ───────────────────────────────────────────────────
has('5 exceeds max consecutive',
  V.validateRequest({ ...base, consecutiveDays: 10, policy: { maxConsecutive: 5 } }),
  'EXCEEDS_MAX_CONSECUTIVE');
lacks('5b within max consecutive',
  V.validateRequest({ ...base, consecutiveDays: 5, policy: { maxConsecutive: 5 } }),
  'EXCEEDS_MAX_CONSECUTIVE');

// ── NOT_VESTED ────────────────────────────────────────────────────────────────
// hireDate 2026-01-01, minTenure 12 → at 2026-06-10 served 5mo → fail
has('6 not vested (NZ annual 12mo)',
  V.validateRequest({ ...base, employee: { hireDate: '2026-01-01' }, policy: { minTenureMonths: 12 } }),
  'NOT_VESTED');
lacks('6b vested when tenure met',
  V.validateRequest({ ...base, employee: { hireDate: '2020-01-01' }, policy: { minTenureMonths: 12 } }),
  'NOT_VESTED');

// ── GENDER_INELIGIBLE ─────────────────────────────────────────────────────────
has('7 gender ineligible',
  V.validateRequest({ ...base, employee: { hireDate: '2020-01-01', gender: 'MALE' }, policy: { genderRestriction: 'FEMALE' } }),
  'GENDER_INELIGIBLE');
lacks('7b gender match ok',
  V.validateRequest({ ...base, employee: { hireDate: '2020-01-01', gender: 'FEMALE' }, policy: { genderRestriction: 'FEMALE' } }),
  'GENDER_INELIGIBLE');

// ── TYPE_INELIGIBLE ───────────────────────────────────────────────────────────
has('8 employment type ineligible',
  V.validateRequest({ ...base, employee: { hireDate: '2020-01-01', employmentType: 'CONTRACT' }, policy: { appliesToEmploymentTypes: 'PERMANENT,PROBATION' } }),
  'TYPE_INELIGIBLE');
lacks('8b employment type allowed',
  V.validateRequest({ ...base, employee: { hireDate: '2020-01-01', employmentType: 'PERMANENT' }, policy: { appliesToEmploymentTypes: 'PERMANENT,PROBATION' } }),
  'TYPE_INELIGIBLE');

// ── REASON_REQUIRED ───────────────────────────────────────────────────────────
has('9 reason required',
  V.validateRequest({ ...base, leaveType: { category: 'SICK', requiresReason: true } }),
  'REASON_REQUIRED');
lacks('9b reason provided',
  V.validateRequest({ ...base, request: { startDate: '2026-06-10', endDate: '2026-06-12', reason: 'flu' }, leaveType: { category: 'SICK', requiresReason: true } }),
  'REASON_REQUIRED');

// ── OVERLAPPING_LEAVE ─────────────────────────────────────────────────────────
has('10 overlapping leave',
  V.validateRequest({ ...base, overlapping: [{ startDate: '2026-06-11', endDate: '2026-06-15', status: 'APPROVED' }] }),
  'OVERLAPPING_LEAVE');
lacks('10b non-overlapping ok',
  V.validateRequest({ ...base, overlapping: [{ startDate: '2026-07-01', endDate: '2026-07-05', status: 'APPROVED' }] }),
  'OVERLAPPING_LEAVE');
lacks('10c rejected leave does not overlap',
  V.validateRequest({ ...base, overlapping: [{ startDate: '2026-06-11', endDate: '2026-06-15', status: 'REJECTED' }] }),
  'OVERLAPPING_LEAVE');

// ── INVALID_RANGE ─────────────────────────────────────────────────────────────
has('11 zero units invalid',
  V.validateRequest({ ...base, units: 0 }), 'INVALID_RANGE');

console.log(`\nvalidators: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of fails) console.error('FAIL', JSON.stringify(f)); process.exit(1); }
