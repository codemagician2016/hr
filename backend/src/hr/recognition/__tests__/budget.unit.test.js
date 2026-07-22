'use strict';

/*
 * budget.unit.test.js — Feature 35 pure budget/threshold logic (§3.4, §4.2).
 * Plain-node, no DB: node backend/src/hr/recognition/__tests__/budget.unit.test.js
 */

const assert = require('assert');
const { budgetWindow, pickBudget, evaluateGive } = require('../budget');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

/* ── budgetWindow ── */
{
  const w = budgetWindow('MONTHLY', new Date(2026, 6, 15)); // 15 Jul 2026
  ok('monthly start', w.start.getTime() === new Date(2026, 6, 1).getTime());
  ok('monthly end (exclusive)', w.end.getTime() === new Date(2026, 7, 1).getTime());

  const dec = budgetWindow('MONTHLY', new Date(2026, 11, 31));
  ok('monthly December rolls into January', dec.end.getTime() === new Date(2027, 0, 1).getTime());

  const q = budgetWindow('QUARTERLY', new Date(2026, 7, 2)); // Aug → Q3 (Jul–Sep)
  ok('quarterly start', q.start.getTime() === new Date(2026, 6, 1).getTime());
  ok('quarterly end', q.end.getTime() === new Date(2026, 9, 1).getTime());

  const q4 = budgetWindow('QUARTERLY', new Date(2026, 10, 20)); // Nov → Q4
  ok('Q4 rolls into next year', q4.end.getTime() === new Date(2027, 0, 1).getTime());

  const y = budgetWindow('YEARLY', new Date(2026, 3, 1));
  ok('yearly window', y.start.getTime() === new Date(2026, 0, 1).getTime() && y.end.getTime() === new Date(2027, 0, 1).getTime());

  const dflt = budgetWindow('UNKNOWN', new Date(2026, 4, 9));
  ok('unknown period defaults to monthly', dflt.start.getMonth() === 4 && dflt.end.getMonth() === 5);
}

/* ── pickBudget precedence: GIVER > DEPARTMENT > ENTITY > TENANT ── */
const CTX = { giverEmployeeId: 'emp1', departmentId: 'dept1', entityId: 'ent1' };
const b = (scope, scopeRefId, extra = {}) => ({ scope, scopeRefId, isActive: true, allocatedPoints: 100, ...extra });
{
  const all = [b('TENANT', null), b('ENTITY', 'ent1'), b('DEPARTMENT', 'dept1'), b('GIVER', 'emp1')];
  ok('GIVER wins over everything', pickBudget(all, CTX).scope === 'GIVER');
  ok('DEPARTMENT wins when no giver budget', pickBudget(all.slice(0, 3), CTX).scope === 'DEPARTMENT');
  ok('ENTITY wins when no giver/dept budget', pickBudget(all.slice(0, 2), CTX).scope === 'ENTITY');
  ok('TENANT is the last resort', pickBudget(all.slice(0, 1), CTX).scope === 'TENANT');
}
{
  ok('mismatched refIds never match', pickBudget([b('GIVER', 'other'), b('DEPARTMENT', 'other')], CTX) === null);
  ok('inactive budgets are skipped', pickBudget([b('GIVER', 'emp1', { isActive: false })], CTX) === null);
  ok('inactive specific falls through to TENANT', pickBudget([b('GIVER', 'emp1', { isActive: false }), b('TENANT', null)], CTX).scope === 'TENANT');
  ok('empty list → null (uncapped)', pickBudget([], CTX) === null);
  ok('null segment fields cannot match narrowed scopes',
    pickBudget([b('DEPARTMENT', 'dept1'), b('ENTITY', 'ent1')], { giverEmployeeId: 'emp1', departmentId: null, entityId: null }) === null);
  ok('TENANT matches even with a null segment', pickBudget([b('TENANT', null)], { giverEmployeeId: 'e', departmentId: null, entityId: null }).scope === 'TENANT');
}

/* ── evaluateGive (the §4.2 approval gate) ── */
const cfg = (over = {}) => ({ pointsEnabled: true, recognitionApprovalThreshold: 100, ...over });
{
  ok('points disabled → never approval', evaluateGive({ config: cfg({ pointsEnabled: false }), totalPoints: 10000, remainingBudget: 0 }).needsApproval === false);
  ok('zero points → never approval', evaluateGive({ config: cfg(), totalPoints: 0, remainingBudget: 0 }).needsApproval === false);
  ok('null config → never approval (fail-open to inline post, zero-config tenants)', evaluateGive({ config: null, totalPoints: 50 }).needsApproval === false);
}
{
  ok('at the threshold → NO approval (strictly above fires)', evaluateGive({ config: cfg(), totalPoints: 100, remainingBudget: null }).needsApproval === false);
  const over = evaluateGive({ config: cfg(), totalPoints: 101, remainingBudget: null });
  ok('above the threshold → approval', over.needsApproval === true && over.reasons.includes('OVER_THRESHOLD'));
  ok('threshold null = never (default)', evaluateGive({ config: cfg({ recognitionApprovalThreshold: null }), totalPoints: 99999, remainingBudget: null }).needsApproval === false);
  ok('threshold 0 = never', evaluateGive({ config: cfg({ recognitionApprovalThreshold: 0 }), totalPoints: 5, remainingBudget: null }).needsApproval === false);
}
{
  const overBudget = evaluateGive({ config: cfg({ recognitionApprovalThreshold: null }), totalPoints: 50, remainingBudget: 49 });
  ok('over budget → approval', overBudget.needsApproval === true && overBudget.reasons.includes('OVER_BUDGET'));
  ok('exactly-remaining budget → NO approval', evaluateGive({ config: cfg({ recognitionApprovalThreshold: null }), totalPoints: 50, remainingBudget: 50 }).needsApproval === false);
  ok('no governing budget (null remaining) → uncapped', evaluateGive({ config: cfg({ recognitionApprovalThreshold: null }), totalPoints: 50, remainingBudget: null }).needsApproval === false);
  ok('zero remaining blocks any pointed give', evaluateGive({ config: cfg({ recognitionApprovalThreshold: null }), totalPoints: 1, remainingBudget: 0 }).needsApproval === true);
}
{
  const both = evaluateGive({ config: cfg(), totalPoints: 150, remainingBudget: 10 });
  ok('both reasons reported together', both.needsApproval && both.reasons.length === 2
    && both.reasons.includes('OVER_THRESHOLD') && both.reasons.includes('OVER_BUDGET'));
}

console.log(`budget.unit: ${passed} checks passed`);
