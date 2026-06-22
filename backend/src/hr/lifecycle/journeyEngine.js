'use strict';

/**
 * journeyEngine.js — Employee-Lifecycle onboarding/offboarding state machine core
 * (Feature 4, docs/features/04 §4.1).
 *
 * PURE: no DB, no I/O, no prisma, no `new Date()` for the business math (the
 * caller supplies the anchor dates in `ctx`). Unit-testable with plain `node`
 * to the exact day — mirrors F2's `derive.js` discipline. The controller fetches
 * the template + task defs + journey + tasks, calls these functions, and wraps
 * the resulting row writes in one `$transaction`.
 *
 * Two entry points:
 *   seedJourneyTasks(template, taskDefs, ctx) -> materialized task list
 *     Snapshots each LifecycleTaskDef into a LifecycleTask payload with the due
 *     date resolved (dueAnchor + dueOffsetDays against ctx anchors) and the owner
 *     resolved to a concrete assignee (employee/user) from ctx.ownerResolution.
 *
 *   advanceJourney(journey, tasks) -> { currentStage, status, sideEffects[] }
 *     Walks the §4.1 stage flow. A stage advances only when ALL its blocking
 *     tasks are terminal-good ({DONE, SKIPPED, NOT_APPLICABLE}); a blocking task
 *     in {OVERDUE, FAILED} blocks the journey. Determinism: same inputs → same
 *     output (idempotent — re-running advance on a settled journey is a no-op).
 */

// ── status sets ──────────────────────────────────────────────────────────────
// A blocking task is "satisfied" (no longer gates its stage) when terminal-good.
const TERMINAL_GOOD = new Set(['DONE', 'SKIPPED', 'NOT_APPLICABLE']);
// A blocking task in one of these states actively blocks the whole journey.
const BLOCKING_BAD = new Set(['OVERDUE', 'FAILED']);

// Terminal journey statuses — advance is a no-op once reached.
const TERMINAL_JOURNEY = new Set(['COMPLETED', 'CANCELLED', 'RESCINDED', 'NO_SHOW']);

// ── ordered onboarding stage flow (docs/features/04 §4.1) ────────────────────
const ONBOARDING_STAGES = [
  'PRE_JOIN',
  'SELF_ONBOARDING',
  'DOCS_ESIGN',
  'PROVISIONING',
  'DAY_ONE',
  'WEEK_ONE',
  'PROBATION',
];
// Offboarding flow (used by 4f; the engine stays direction-agnostic so the same
// gating logic drives both pipelines).
const OFFBOARDING_STAGES = [
  'SEPARATION_INITIATED',
  'NOTICE',
  'CLEARANCE',
  'ASSET_RETURN',
  'FNF',
  'EXIT_DOCS',
  'POST_EXIT',
];

function stageOrder(direction) {
  return direction === 'OFFBOARDING' ? OFFBOARDING_STAGES : ONBOARDING_STAGES;
}

// ── date helpers (pure; @db.Date values are midnight-UTC instants) ───────────
function toMs(x) {
  if (x == null) return null;
  return x instanceof Date ? x.getTime() : new Date(x).getTime();
}
function addDays(baseMs, days) {
  return new Date(baseMs + (Number(days) || 0) * 86400000);
}

/**
 * resolveDueDate(def, ctx) — dueAnchor + dueOffsetDays against the journey anchors.
 *   OFFER_ACCEPT -> ctx.offerAcceptedAt
 *   JOIN_DATE    -> ctx.joinDate
 *   NOTICE_START -> ctx.noticeStartDate
 *   LWD          -> ctx.lastWorkingDay
 *   RELIEVING    -> ctx.relievingDate
 * Returns a Date (UTC midnight) or null when the anchor isn't known yet.
 */
function resolveDueDate(def, ctx) {
  const anchorMap = {
    OFFER_ACCEPT: ctx.offerAcceptedAt,
    JOIN_DATE: ctx.joinDate,
    NOTICE_START: ctx.noticeStartDate,
    LWD: ctx.lastWorkingDay,
    RELIEVING: ctx.relievingDate,
  };
  const anchor = anchorMap[def.dueAnchor || 'JOIN_DATE'];
  const baseMs = toMs(anchor);
  if (baseMs == null) return null;
  // Normalize to the UTC date floor so the result is a clean @db.Date value.
  const dayFloor = Math.floor(baseMs / 86400000) * 86400000;
  return addDays(dayFloor, def.dueOffsetDays || 0);
}

/**
 * resolveOwner(def, ctx) — turn the abstract TaskOwner role into a concrete
 * assignee. `ctx.ownerResolution` maps each TaskOwner -> { employeeId?, userId? }
 * (the caller derives it: NEW_HIRE/EMPLOYEE = the subject, MANAGER = the hiring
 * manager, HR/IT/FINANCE/ADMIN = the configured function owner). Unmapped owners
 * resolve to nulls (an unassigned task surfaces in the "all" board, not "me").
 */
function resolveOwner(def, ctx) {
  const res = (ctx.ownerResolution && ctx.ownerResolution[def.ownerRole]) || {};
  return {
    assigneeEmployeeId: res.employeeId != null ? res.employeeId : null,
    assigneeUserId: res.userId != null ? res.userId : null,
  };
}

/**
 * seedJourneyTasks(template, taskDefs, ctx) — materialize template task defs into
 * LifecycleTask create-payloads for one journey. PURE: returns plain objects; the
 * caller stamps journeyId/businessId and persists. Ordered by (stage flow,
 * taskOrder) so the board renders deterministically.
 *
 * ctx = {
 *   businessId, offerAcceptedAt, joinDate, noticeStartDate, lastWorkingDay,
 *   relievingDate, ownerResolution: { [TaskOwner]: { employeeId?, userId? } }
 * }
 */
function seedJourneyTasks(template, taskDefs, ctx) {
  const c = ctx || {};
  const order = stageOrder(template && template.direction);
  const stageRank = (s) => {
    const i = order.indexOf(s);
    return i === -1 ? order.length : i;
  };

  return [...(taskDefs || [])]
    .filter((d) => d)
    .sort((a, b) =>
      stageRank(a.stageKey) - stageRank(b.stageKey) ||
      (a.taskOrder || 0) - (b.taskOrder || 0))
    .map((def) => {
      const due = resolveDueDate(def, c);
      const owner = resolveOwner(def, c);
      return {
        businessId: c.businessId != null ? c.businessId : def.businessId,
        taskDefId: def.id != null ? def.id : null,
        stageKey: def.stageKey,
        taskKey: def.taskKey != null ? def.taskKey : null,
        title: def.title,
        ownerRole: def.ownerRole,
        assigneeEmployeeId: owner.assigneeEmployeeId,
        assigneeUserId: owner.assigneeUserId,
        dueDate: due,
        isBlocking: def.isBlocking !== false,
        isMandatory: def.isMandatory !== false,
        status: 'PENDING',
      };
    });
}

// ── advance helpers ──────────────────────────────────────────────────────────
// Blocking tasks of a stage = tasks at that stage that gate it (blocking AND
// mandatory). Non-blocking / non-mandatory tasks never hold a stage back.
function stageBlockers(tasks, stage) {
  return (tasks || []).filter(
    (t) => t && t.stageKey === stage && t.isBlocking !== false && t.isMandatory !== false,
  );
}
function stageSatisfied(tasks, stage) {
  const blockers = stageBlockers(tasks, stage);
  return blockers.every((t) => TERMINAL_GOOD.has(t.status));
}
function anyBlockingBad(tasks) {
  return (tasks || []).some(
    (t) => t && t.isBlocking !== false && t.isMandatory !== false && BLOCKING_BAD.has(t.status),
  );
}
function allDone(tasks) {
  // Every task (blocking or not) is in a terminal-good state.
  return (tasks || []).every((t) => TERMINAL_GOOD.has(t.status));
}

/**
 * advanceJourney(journey, tasks) -> { currentStage, status, sideEffects[] }
 *
 * PURE. Given the journey + its full task list, computes the furthest stage the
 * blocking gates allow and the resulting JourneyStatus. The caller persists the
 * returned stage/status and emits the side-effects (notifications, stage spawns).
 *
 * Rules (§4.1):
 *  - Terminal journeys (COMPLETED/CANCELLED/RESCINDED/NO_SHOW) are immutable → no-op.
 *  - HR holds (ON_HOLD) freeze progression until lifted (no-op while held).
 *  - Walk the direction's stage flow from the current stage forward; advance past
 *    each stage whose blocking+mandatory tasks are all terminal-good. Stop at the
 *    first unsatisfied stage (that becomes currentStage).
 *  - Any blocking+mandatory task in {OVERDUE, FAILED} → status BLOCKED (+notify HR),
 *    stage is held where it is.
 *  - Reaching the end of the flow with every task terminal-good → COMPLETED.
 *  - Otherwise → IN_PROGRESS (a touched journey) or NOT_STARTED (nothing actioned).
 */
function advanceJourney(journey, tasks) {
  const j = journey || {};
  const list = tasks || [];
  const order = stageOrder(j.direction);

  // Immutable terminal states — never recompute.
  if (TERMINAL_JOURNEY.has(j.status)) {
    return { currentStage: j.currentStage, status: j.status, sideEffects: [] };
  }
  // HR pause freezes the machine until explicitly resumed by the controller.
  if (j.status === 'ON_HOLD') {
    return { currentStage: j.currentStage, status: 'ON_HOLD', sideEffects: [] };
  }

  const sideEffects = [];

  // Blocking failure short-circuits everything → BLOCKED, stage unchanged.
  if (anyBlockingBad(list)) {
    sideEffects.push({ type: 'NOTIFY_HR', reason: 'BLOCKING_TASK_FAILED', journeyId: j.id });
    return { currentStage: j.currentStage, status: 'BLOCKED', sideEffects };
  }

  // Walk forward from the current stage; advance past each satisfied stage.
  let idx = order.indexOf(j.currentStage);
  if (idx === -1) idx = 0; // unknown/unset stage → start of the flow
  let stage = order[idx];

  while (idx < order.length - 1 && stageSatisfied(list, stage)) {
    const from = stage;
    idx += 1;
    stage = order[idx];
    sideEffects.push({ type: 'STAGE_ENTERED', from, to: stage, journeyId: j.id });
  }

  // Status resolution.
  const everyTaskGood = allDone(list);
  const lastStage = order[order.length - 1];
  let status;
  if (stage === lastStage && stageSatisfied(list, stage) && everyTaskGood) {
    // Reached + cleared the terminal stage with nothing outstanding → done.
    status = 'COMPLETED';
    sideEffects.push({ type: 'JOURNEY_COMPLETED', journeyId: j.id });
  } else {
    const anyTouched = list.some(
      (t) => t && (t.status !== 'PENDING' || (j.status && j.status !== 'NOT_STARTED')),
    );
    status = anyTouched ? 'IN_PROGRESS' : 'NOT_STARTED';
  }

  return { currentStage: stage, status, sideEffects };
}

module.exports = {
  seedJourneyTasks,
  advanceJourney,
  // exported for unit-testing the pure resolvers + stage helpers
  _internals: {
    resolveDueDate,
    resolveOwner,
    stageBlockers,
    stageSatisfied,
    anyBlockingBad,
    allDone,
    stageOrder,
    TERMINAL_GOOD,
    BLOCKING_BAD,
    TERMINAL_JOURNEY,
    ONBOARDING_STAGES,
    OFFBOARDING_STAGES,
  },
};
