'use strict';

/**
 * conditions.test.js — pure unit tests for the WorkflowStep condition evaluator.
 * No DB, no network. Run: node --test src/hr/approvals/__tests__/conditions.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matches, validateCondition } = require('../conditions');

test('null/undefined/empty condition always matches', () => {
  assert.equal(matches(null, { amount: 1 }), true);
  assert.equal(matches(undefined, {}), true);
  assert.equal(matches({}, { amount: 999 }), true);
});

test('numeric operators >, >=, <, <=', () => {
  assert.equal(matches({ amount: { '>': 50000 } }, { amount: 60000 }), true);
  assert.equal(matches({ amount: { '>': 50000 } }, { amount: 50000 }), false);
  assert.equal(matches({ amount: { '>=': 50000 } }, { amount: 50000 }), true);
  assert.equal(matches({ days: { '<': 5 } }, { days: 4 }), true);
  assert.equal(matches({ days: { '<=': 5 } }, { days: 5 }), true);
  assert.equal(matches({ days: { '<=': 5 } }, { days: 6 }), false);
});

test('amount handles Decimal-as-string', () => {
  assert.equal(matches({ amount: { '>': 1000 } }, { amount: '1500.00' }), true);
  assert.equal(matches({ amount: { '>': 1000 } }, { amount: '500.00' }), false);
});

test('in operator over categoryCode / departmentId / employeeLevel', () => {
  assert.equal(matches({ categoryCode: { in: ['TRAVEL', 'CLIENT'] } }, { categoryCode: 'TRAVEL' }), true);
  assert.equal(matches({ categoryCode: { in: ['TRAVEL', 'CLIENT'] } }, { categoryCode: 'MEAL' }), false);
  assert.equal(matches({ employeeLevel: { in: ['M1', 'M2'] } }, { employeeLevel: 'M1' }), true);
  assert.equal(matches({ departmentId: { in: ['d1'] } }, { departmentId: 'd2' }), false);
});

test('eq operator (numeric + string)', () => {
  assert.equal(matches({ days: { eq: 1 } }, { days: 1 }), true);
  assert.equal(matches({ days: { eq: 1 } }, { days: 2 }), false);
  assert.equal(matches({ currencyCode: { eq: 'INR' } }, { currencyCode: 'INR' }), true);
  assert.equal(matches({ currencyCode: { eq: 'INR' } }, { currencyCode: 'NZD' }), false);
});

test('implicit AND across keys', () => {
  const cond = { amount: { '>': 1000 }, categoryCode: { in: ['CLIENT'] } };
  assert.equal(matches(cond, { amount: 2000, categoryCode: 'CLIENT' }), true);
  assert.equal(matches(cond, { amount: 2000, categoryCode: 'MEAL' }), false);
  assert.equal(matches(cond, { amount: 500, categoryCode: 'CLIENT' }), false);
});

test('range on one key (multiple ops AND together)', () => {
  const cond = { amount: { '>=': 1000, '<': 5000 } };
  assert.equal(matches(cond, { amount: 2000 }), true);
  assert.equal(matches(cond, { amount: 5000 }), false);
  assert.equal(matches(cond, { amount: 999 }), false);
});

test('any: [...] is an OR', () => {
  const cond = { any: [{ amount: { '>': 100000 } }, { categoryCode: { in: ['TRAVEL'] } }] };
  assert.equal(matches(cond, { amount: 5, categoryCode: 'TRAVEL' }), true);
  assert.equal(matches(cond, { amount: 200000, categoryCode: 'MEAL' }), true);
  assert.equal(matches(cond, { amount: 5, categoryCode: 'MEAL' }), false);
});

test('any combined with another key (AND of OR + key)', () => {
  const cond = { departmentId: { in: ['sales'] }, any: [{ amount: { '>': 1000 } }, { days: { '>': 10 } }] };
  assert.equal(matches(cond, { departmentId: 'sales', amount: 2000 }), true);
  assert.equal(matches(cond, { departmentId: 'eng', amount: 2000 }), false);
  assert.equal(matches(cond, { departmentId: 'sales', amount: 5, days: 3 }), false);
});

test('fail-closed: unknown key ⇒ false', () => {
  assert.equal(matches({ secretField: { '>': 0 } }, { secretField: 9 }), false);
});

test('fail-closed: unknown operator ⇒ false', () => {
  assert.equal(matches({ amount: { regex: '.*' } }, { amount: 5 }), false);
});

test('fail-closed: non-comparable / missing ctx value ⇒ false', () => {
  assert.equal(matches({ amount: { '>': 50000 } }, {}), false);
  assert.equal(matches({ amount: { '>': 50000 } }, { amount: 'abc' }), false);
  assert.equal(matches({ categoryCode: { in: ['X'] } }, { categoryCode: null }), false);
});

test('fail-closed: malformed shapes never throw', () => {
  assert.equal(matches({ amount: 5 }, { amount: 5 }), false); // predicate not an object
  assert.equal(matches([], { amount: 5 }), false);           // top-level array
  assert.equal(matches({ any: [] }, {}), false);             // empty OR
  assert.equal(matches({ amount: {} }, { amount: 5 }), false); // empty predicate
});

test('validateCondition accepts well-formed, rejects bad', () => {
  assert.equal(validateCondition(null).ok, true);
  assert.equal(validateCondition({}).ok, true);
  assert.equal(validateCondition({ amount: { '>': 50000 } }).ok, true);
  assert.equal(validateCondition({ any: [{ amount: { '>': 1 } }] }).ok, true);
  assert.equal(validateCondition({ bogus: { '>': 1 } }).ok, false);
  assert.equal(validateCondition({ amount: { weird: 1 } }).ok, false);
  assert.equal(validateCondition({ amount: { in: 'notarray' } }).ok, false);
  assert.equal(validateCondition({ amount: { '>': 'NaN' } }).ok, false);
  assert.equal(validateCondition({ any: [] }).ok, false);
});
