'use strict';

/**
 * workflowResolver.test.js — pure unit tests for BUILT_IN_DEFAULT + scope matching.
 * No DB. Run: node --test src/hr/approvals/__tests__/workflowResolver.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { builtInSteps, BUILT_IN_DEFAULT, scopeMatches, EXPENSE_HR_THRESHOLD } = require('../workflowResolver');

test('LEAVE built-in default = single manager step, escalate @48h (today behaviour)', () => {
  const steps = builtInSteps('LEAVE');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].approverType, 'REPORTING_MANAGER');
  assert.equal(steps[0].approverRefId, '1');
  assert.equal(steps[0].slaHours, 48);
  assert.equal(steps[0].onTimeoutAction, 'ESCALATE');
});

test('EXPENSE built-in default = manager then HR-over-threshold (today behaviour)', () => {
  const steps = builtInSteps('EXPENSE');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].approverType, 'REPORTING_MANAGER');
  assert.equal(steps[1].approverType, 'HR');
  // HR step conditional on amount > threshold, so small claims stop at the manager.
  assert.deepEqual(steps[1].conditionJson, { amount: { '>': EXPENSE_HR_THRESHOLD } });
});

test('TRAVEL has a built-in (manager + HR-over-threshold)', () => {
  assert.ok(BUILT_IN_DEFAULT.TRAVEL);
  assert.equal(BUILT_IN_DEFAULT.TRAVEL[0].approverType, 'REPORTING_MANAGER');
});

test('unknown module falls back to the generic single-manager default', () => {
  // Wave 2B gave SEPARATION a bespoke default — use a truly unmapped key here.
  const steps = builtInSteps('NOT_A_REAL_MODULE');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].approverType, 'REPORTING_MANAGER');
});

test('Wave 2B bespoke defaults: SEPARATION/PAYRUN payroll-manager, OFFER auto', () => {
  assert.equal(builtInSteps('SEPARATION')[0].approverType, 'PAYROLL_MANAGER');
  assert.equal(builtInSteps('PAYRUN')[0].approverType, 'PAYROLL_MANAGER');
  assert.equal(builtInSteps('OFFER')[0].approverType, 'AUTO_APPROVE');
  assert.equal(builtInSteps('ASSET')[0].approverType, 'AUTO_APPROVE');
  assert.equal(builtInSteps('LOAN')[0].approverType, 'HR');
});

test('scopeMatches: null scope = default (matches anything)', () => {
  assert.equal(scopeMatches(null, { departmentId: 'd1' }), true);
  assert.equal(scopeMatches(undefined, {}), true);
});

test('scopeMatches: department/level/location narrowing', () => {
  assert.equal(scopeMatches({ departmentIds: ['sales'] }, { departmentId: 'sales' }), true);
  assert.equal(scopeMatches({ departmentIds: ['sales'] }, { departmentId: 'eng' }), false);
  assert.equal(scopeMatches({ employeeLevels: ['M1', 'M2'] }, { employeeLevel: 'M1' }), true);
  assert.equal(scopeMatches({ locationIds: ['mum'] }, { locationId: 'blr' }), false);
  // all declared dimensions must hold (AND):
  assert.equal(scopeMatches({ departmentIds: ['sales'], employeeLevels: ['M1'] }, { departmentId: 'sales', employeeLevel: 'IC' }), false);
});

test('scopeMatches: missing ctx value for a declared dimension ⇒ no match', () => {
  assert.equal(scopeMatches({ departmentIds: ['sales'] }, {}), false);
});
