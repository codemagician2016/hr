'use strict';

/**
 * nextAction.js — pick the single next-best step, deterministically.
 *
 * The whole guide hangs off one sentence ("do this next"), so the choice has to be
 * STABLE: the same operator, on the same tenant, must see the same step on Monday
 * and on Friday until they finish it. Everything here is a pure function of the
 * already-serialised step list — no clock, no randomness, no per-request tie-break.
 *
 * ELIGIBILITY — all four must hold:
 *   state === 'todo'        (done / locked / dismissed are out; 'unknown' is out
 *                            too — we never send someone to fix a step whose probe
 *                            we could not even read)
 *   probe === 'ok'
 *   permitted === true      (relaxed for the blocked-candidate pass, see below)
 *   every dependsOn resolved (prerequisitesMet)
 *
 * RANKING — ascending on [ -blocking, required?0:1, stageOrder, order ]:
 *   1. unblock the most work first  (blocking is the transitive dependant count,
 *      computed once at module load in checklistItems.js)
 *   2. required before recommended
 *   3. earlier stage first
 *   4. declared order — the final, total tie-break, so ties are impossible
 *
 * PERMISSION SPLIT — when the top-ranked eligible step is out of this operator's
 * reach we still show them something they CAN do (`nextAction`) plus who to ask
 * (`nextActionBlocked`). Rendering a dead button, or an empty card, is worse than
 * saying "this one needs Finance".
 */

const { STEPS } = require('./checklistItems');

// Ascending comparator over the ranking tuple.
function rank(a, b) {
  if (a.blocking !== b.blocking) return b.blocking - a.blocking; // -blocking asc
  const ra = a.required ? 0 : 1;
  const rb = b.required ? 0 : 1;
  if (ra !== rb) return ra - rb;
  if (a.stageOrder !== b.stageOrder) return a.stageOrder - b.stageOrder;
  return a.order - b.order;
}

function isEligible(step) {
  return step.state === 'todo' && step.probe === 'ok' && step.prerequisitesMet === true;
}

function best(steps, predicate) {
  let winner = null;
  for (const s of steps) {
    if (!predicate(s)) continue;
    if (!winner || rank(s, winner) < 0) winner = s;
  }
  return winner;
}

// The next-action payload is a flattened summary, not the whole step row — the
// card renders it standalone and must not have to reach back into the accordion.
function toNextAction(step, scopedKeys) {
  const at = scopedKeys.indexOf(step.key);
  return {
    key: step.key,
    stage: step.stage,
    label: step.label,
    description: step.description,
    why: step.why,
    route: step.route, // BARE — the client appends ?from=setup
    cta: step.ctaVerb || 'Set up',
    required: step.required,
    orderInScope: at >= 0 ? at + 1 : null, // "Step 4 of 44"
    minutes: step.minutes,
    doneBy: step.doneBy,
    blocking: step.blocking,
  };
}

/**
 * pickNextAction(steps, scopedKeys)
 *
 * @param {Array}  steps       every SERIALISED step (including not-permitted ones,
 *                             so the blocked candidate can be found)
 * @param {Array}  scopedKeys  the operator's scored set, in declared order — used
 *                             only to number "Step N of M"
 * @returns {{ nextAction: Object|null, nextActionBlocked: Object|null }}
 */
function pickNextAction(steps, scopedKeys = []) {
  // The top-ranked step ANYONE in the tenant could do next…
  const topAnyone = best(steps, isEligible);
  if (!topAnyone) return { nextAction: null, nextActionBlocked: null };

  // …and the top-ranked step THIS operator can do next.
  const topMine = best(steps, (s) => isEligible(s) && s.permitted === true);

  if (topMine && topMine.key === topAnyone.key) {
    return { nextAction: toNextAction(topMine, scopedKeys), nextActionBlocked: null };
  }

  // The real next step belongs to someone else: name it (so the operator can go and
  // ask) and hand this operator the best thing they can actually get on with.
  return {
    nextAction: topMine ? toNextAction(topMine, scopedKeys) : null,
    nextActionBlocked: {
      key: topAnyone.key,
      label: topAnyone.label,
      permission: topAnyone.permission,
      route: topAnyone.route,
    },
  };
}

// The stage the guide should auto-open. Null when there is nothing left to do.
function stageOfNextAction(nextAction) {
  return nextAction ? nextAction.stage : null;
}

// Declaration-order key list — handy for tests that need a stable reference order.
const DECLARED_KEYS = Object.freeze(STEPS.map((s) => s.key));

module.exports = { pickNextAction, stageOfNextAction, rank, isEligible, DECLARED_KEYS };
