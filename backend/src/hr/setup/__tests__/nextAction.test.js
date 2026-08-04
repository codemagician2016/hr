'use strict';

/*
 * nextAction.test.js — the ranking is deterministic, stable and permission-aware.
 *
 * Pure unit; no DB. The whole guide hangs off one sentence ("do this next"), and the
 * failure mode nobody would notice in QA is INSTABILITY: a next step that changes
 * identity between two page loads makes the guide feel broken even though every
 * number is right. So the ranking is asserted here as a total order.
 *
 *   node src/hr/setup/__tests__/nextAction.test.js
 */

const { pickNextAction, rank, isEligible } = require('../nextAction');
const { STEPS } = require('../checklistItems');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

// Build the serialised row shape pickNextAction consumes, from the real registry so
// blocking/order/stageOrder are the production values.
function rows(overrides = {}) {
  return STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    description: s.description,
    why: s.why,
    stage: s.stage,
    stageOrder: s.stageOrder,
    order: s.order,
    required: s.required,
    route: s.route,
    ctaVerb: s.cta,
    permission: s.permission,
    blocking: s.blocking,
    minutes: s.minutes,
    doneBy: s.doneBy,
    state: 'todo',
    probe: 'ok',
    permitted: true,
    prerequisitesMet: s.dependsOn.length === 0,
    ...(overrides[s.key] || {}),
  }));
}

// Mark a set of keys done and re-resolve prerequisites, the way the controller does.
function withDone(doneKeys, extra = {}) {
  const done = new Set(doneKeys);
  const base = {};
  for (const s of STEPS) {
    base[s.key] = { state: done.has(s.key) ? 'done' : 'todo' };
  }
  const merged = {};
  for (const s of STEPS) merged[s.key] = { ...base[s.key], ...(extra[s.key] || {}) };
  const list = rows(merged);
  const byKey = new Map(list.map((r) => [r.key, r]));
  for (const r of list) {
    const step = STEPS.find((s) => s.key === r.key);
    r.prerequisitesMet = step.dependsOn.every((d) => {
      const dep = byKey.get(d);
      return !dep || dep.state !== 'todo';
    });
  }
  return list;
}

log('\n=== Setup checklist — next-action ranking ===\n');

// ── A) A brand-new tenant ─────────────────────────────────────────────────────
{
  const list = withDone([]);
  const { nextAction, nextActionBlocked } = pickNextAction(list, list.map((r) => r.key));
  ok(nextAction && nextAction.key === 'country', `an empty tenant is sent to the country lock first (${nextAction && nextAction.key})`);
  ok(nextAction.blocking === 57, 'because it blocks 57 other steps');
  ok(nextActionBlocked === null, 'nothing is blocked for an operator who holds every key');
  ok(nextAction.cta === 'Choose your country', `the card gets the authored verb+object CTA ("${nextAction.cta}")`);
  ok(nextAction.orderInScope === 1, 'orderInScope numbers the step within the operator\'s scored set');
  ok(nextAction.route === '/settings/company-profile?tab=country' && !nextAction.route.includes('from='), 'the route is BARE — the client appends ?from=setup');
}

// ── B) Stability: the same input always yields the same answer ───────────────
{
  const list = withDone(['country', 'company_profile']);
  const first = pickNextAction(list, []).nextAction.key;
  // Shuffle hard: if any tie-break were positional or random this would drift.
  for (let i = 0; i < 25; i += 1) {
    const shuffled = [...list].sort(() => Math.random() - 0.5);
    if (pickNextAction(shuffled, []).nextAction.key !== first) {
      failures += 1; log('  FAIL  next action drifted under re-ordering'); break;
    }
  }
  ok(true, `the next action is order-independent (25 shuffles all chose "${first}")`);
  ok(first === 'entity', 'with the country locked, the registered company is next');
}

// ── C) The ranking tuple, in priority order ──────────────────────────────────
{
  const a = { blocking: 9, required: false, stageOrder: 5, order: 70 };
  const b = { blocking: 2, required: true, stageOrder: 1, order: 1 };
  ok(rank(a, b) < 0, 'blocking wins over required: unblocking nine steps beats a leaf that happens to be required');

  const c = { blocking: 3, required: true, stageOrder: 4, order: 40 };
  const d = { blocking: 3, required: false, stageOrder: 1, order: 2 };
  ok(rank(c, d) < 0, 'at equal blocking, required beats recommended');

  const e = { blocking: 0, required: false, stageOrder: 2, order: 30 };
  const f = { blocking: 0, required: false, stageOrder: 4, order: 5 };
  ok(rank(e, f) < 0, 'at equal blocking and required-ness, the earlier stage wins');

  const g = { blocking: 0, required: false, stageOrder: 3, order: 10 };
  const h = { blocking: 0, required: false, stageOrder: 3, order: 11 };
  ok(rank(g, h) < 0, 'declared order is the final tie-break, so a tie is impossible');
}

// ── D) Eligibility gates ─────────────────────────────────────────────────────
{
  const base = { state: 'todo', probe: 'ok', prerequisitesMet: true };
  ok(isEligible(base) === true, 'todo + ok probe + prerequisites met is eligible');
  ok(isEligible({ ...base, state: 'done' }) === false, 'a done step is not eligible');
  ok(isEligible({ ...base, state: 'locked' }) === false, 'a locked step is never the next action (it is an upsell, not a task)');
  ok(isEligible({ ...base, state: 'dismissed' }) === false, 'a dismissed step is never the next action');
  ok(isEligible({ ...base, state: 'unknown', probe: 'unknown' }) === false, 'a step whose probe failed is never the next action');
  ok(isEligible({ ...base, prerequisitesMet: false }) === false, 'a step whose prerequisites are unmet is not eligible');
}

// ── E) Prerequisites actually gate ───────────────────────────────────────────
{
  // Nothing done: `employees` waits on `entity`, so it must not be offered.
  const list = withDone([]);
  const employees = list.find((r) => r.key === 'employees');
  ok(employees.prerequisitesMet === false, 'employees is not offered before the registered company exists');
  const after = withDone(['country', 'entity']);
  ok(after.find((r) => r.key === 'employees').prerequisitesMet === true, 'once the company exists, employees unlocks');
  ok(pickNextAction(after, []).nextAction.key === 'employees', 'and becomes the next action (25 steps hang off it)');
}

// ── F) The permission split ──────────────────────────────────────────────────
{
  // An operator who can do everything EXCEPT lock the country: they must still be
  // given something to do, and told who owns the step they cannot reach.
  const list = withDone([], { country: { permitted: false } });
  const { nextAction, nextActionBlocked } = pickNextAction(list, list.filter((r) => r.permitted).map((r) => r.key));
  ok(nextActionBlocked && nextActionBlocked.key === 'country', 'the unreachable top-ranked step is named as blocked');
  ok(nextActionBlocked.permission === 'canManageCompanyProfile', 'with the permission the operator is missing, so they know who to ask');
  ok(nextAction && nextAction.key !== 'country', `and the operator is still given something they CAN do (${nextAction && nextAction.key})`);
  // branding has no prerequisites and unblocks four steps (custom domain,
  // letterheads → templates, careers page), so it out-ranks the other reachable
  // leaves under the -blocking-first tuple.
  ok(nextAction.key === 'branding', `namely the highest-blocking reachable step with no unmet prerequisite (${nextAction.key})`);
}

// ── G) Terminal states ───────────────────────────────────────────────────────
{
  const allDone = withDone(STEPS.map((s) => s.key));
  ok(pickNextAction(allDone, []).nextAction === null, 'everything done → no next action (the done card takes over)');

  const allLocked = rows(Object.fromEntries(STEPS.map((s) => [s.key, { state: 'locked' }])));
  ok(pickNextAction(allLocked, []).nextAction === null, 'everything locked/dismissed → no next action, and the score is already 100');

  const noPerms = rows(Object.fromEntries(STEPS.map((s) => [s.key, { permitted: false }])));
  const out = pickNextAction(noPerms, []);
  ok(out.nextAction === null && out.nextActionBlocked && out.nextActionBlocked.key === 'country', 'an operator with no keys at all sees only the blocked pointer, never a dead button');
}

log(`\n=== ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} ===\n`);
if (failures > 0) process.exit(1);
