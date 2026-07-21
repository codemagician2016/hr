'use strict';

/*
 * leaveAudit.unit.test.js — pure checks for the leave-audit build:
 *   - probation gate (validators §6b): blocks ONLY when policy opts in AND the
 *     employee is on PROBATION; orthogonal to minTenureMonths.
 *   - LEAVE_BALANCE import validator: required fields, period format, negatives.
 *   - prorataOnJoin join-cutoff behaviour (the rule the runner now wires).
 *
 * Plain-node:  node backend/src/hr/leave/__tests__/leaveAudit.unit.test.js
 */

const assert = require('assert');
const { validateRequest } = require('../validators');
const accrual = require('../accrual');
const { validateRow } = require('../../migration/validators');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

const baseInput = {
  request: { startDate: '2026-08-10', endDate: '2026-08-10', reason: 'x' },
  units: 1,
  consecutiveDays: 1,
  policy: { minNoticeDays: 0 },
  leaveType: {},
  balance: { closing: 10, pendingApproval: 0 },
  employee: { hireDate: '2020-01-01', status: 'PROBATION', gender: 'FEMALE' },
  overlapping: [],
  asOf: '2026-08-01',
};

/* ── probation gate ─────────────────────────────────────────────────────────*/
{
  const blocked = validateRequest({ ...baseInput, policy: { ...baseInput.policy, blockDuringProbation: true } });
  ok('probation + gate ON → PROBATION_BLOCKED', !blocked.ok && blocked.errors.some((e) => e.code === 'PROBATION_BLOCKED'));

  const allowedOff = validateRequest({ ...baseInput, policy: { ...baseInput.policy, blockDuringProbation: false } });
  ok('probation + gate OFF → allowed', !allowedOff.errors.some((e) => e.code === 'PROBATION_BLOCKED'));

  const confirmed = validateRequest({
    ...baseInput,
    policy: { ...baseInput.policy, blockDuringProbation: true },
    employee: { ...baseInput.employee, status: 'ACTIVE' },
  });
  ok('confirmed employee + gate ON → allowed', !confirmed.errors.some((e) => e.code === 'PROBATION_BLOCKED'));

  // Orthogonality: short tenure but confirmed passes the probation gate (tenure
  // check governs separately).
  const shortTenure = validateRequest({
    ...baseInput,
    policy: { ...baseInput.policy, blockDuringProbation: true, minTenureMonths: 0 },
    employee: { hireDate: '2026-07-20', status: 'ACTIVE' },
  });
  ok('new-but-confirmed employee passes', !shortTenure.errors.some((e) => e.code === 'PROBATION_BLOCKED'));
}

/* ── LEAVE_BALANCE import validator ─────────────────────────────────────────*/
{
  const good = validateRow('LEAVE_BALANCE', { employeeCode: 'E1', leaveTypeCode: 'el', periodCode: '2026-27', openingBalance: '12.5' }, {});
  ok('valid row passes', good.findings.filter((f) => f.severity === 'ERROR').length === 0);
  ok('leaveTypeCode uppercased', good.normalized.leaveTypeCode === 'EL');
  ok('naturalKey emp|type|period', good.naturalKey === 'E1|EL|2026-27');

  const neg = validateRow('LEAVE_BALANCE', { employeeCode: 'E1', leaveTypeCode: 'EL', periodCode: '2026-27', openingBalance: '-2' }, {});
  ok('negative opening rejected', neg.findings.some((f) => f.code === 'BAD_NUMBER'));

  const badPeriod = validateRow('LEAVE_BALANCE', { employeeCode: 'E1', leaveTypeCode: 'EL', periodCode: 'FY26', openingBalance: '1' }, {});
  ok('bad period format rejected', badPeriod.findings.some((f) => f.code === 'BAD_PERIOD'));

  const missing = validateRow('LEAVE_BALANCE', { employeeCode: '', leaveTypeCode: '', periodCode: '', openingBalance: '' }, {});
  ok('missing fields all flagged', missing.findings.filter((f) => f.code === 'REQUIRED').length >= 3);
}

/* ── prorataOnJoin (the rule the runner now wires) ──────────────────────────*/
{
  const policy = { accrualMethod: 'MONTHLY_ACCRUAL', entitlementPerYear: 12, accrualFrequency: 'MONTHLY', accrualProrateOnJoin: true };
  const early = accrual.prorataOnJoin(policy, '2026-08-10', '2026-08-01', '2026-08-31');
  ok('joined ≤ 15th → full month tick (1)', early === 1);
  const late = accrual.prorataOnJoin(policy, '2026-08-20', '2026-08-01', '2026-08-31');
  ok('joined after cutoff → 0 for the month', late === 0);
  const upfront = accrual.prorataOnJoin(
    { accrualMethod: 'UPFRONT_ANNUAL', entitlementPerYear: 24, accrualProrateOnJoin: true },
    '2026-10-01', '2026-04-01', '2027-03-31',
  );
  ok('upfront mid-year join prorates (~12)', upfront >= 11.5 && upfront <= 12.5);
}

console.log(`leaveAudit.unit: ${passed} checks passed`);
