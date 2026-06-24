'use strict';

/**
 * placementStateMachine.js — Feature 34 §5.5: the 9-box placement lifecycle as a
 * PURE transition table + guard evaluator (no DB; mirrors reviewStateMachine.js:46).
 * The controller wraps each call in a tx with `WHERE id AND version` (optimistic lock)
 * and writes the AuditLog + NineBoxMove rows; this module only answers "is this event
 * legal from this state, for this actor, given this placement?" and "what's next?".
 *
 *   DRAFT      → (authorPotential, by manager/HR, review ≥ MANAGER_SUBMITTED) → PROPOSED
 *   PROPOSED   → (move,            by HR/skip-level, session OPEN, actor≠subject) → CALIBRATED
 *   CALIBRATED → (move,            …)                                           → CALIBRATED (idempotent)
 *   CALIBRATED → (finalize,        by canManageSuccession)                      → FINALIZED
 *   FINALIZED  → (reopen,          by HR)                                       → PROPOSED
 *
 * SoD (§5.3): `move` requires actor ≠ subject — the ninebox.calibrate scope action
 * already drops self from the resolved id-set, so a manager is structurally absent
 * from their own calibration cohort; this guard is the in-code backstop.
 */

const STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  PROPOSED: 'PROPOSED',
  CALIBRATED: 'CALIBRATED',
  FINALIZED: 'FINALIZED',
});

// The F8 review statuses at/after which a perf axis exists (manager has rated).
const RATED_STATUSES = new Set(['MANAGER_SUBMITTED', 'CALIBRATED', 'ACKNOWLEDGED', 'CLOSED']);

function isActor(ctx, id) {
  return id && ctx.actorEmployeeId && ctx.actorEmployeeId === id;
}

// ctx fields the guards read:
//   actorEmployeeId   — the acting employee (resolved from session, never trusted body)
//   subjectEmployeeId — the placement's employee
//   isHr              — actor holds canManagePerformanceCycle (config/HR)
//   isManagerOfSubject— actor is the subject's manager (TEAM author grant)
//   isSkipLevel       — actor is a skip-level over the subject (calibration grant)
//   canSucceed        — actor holds canManageSuccession (finalize/reopen)
//   reviewStatus      — the linked PerformanceReview status (perf-axis existence guard)
//   sessionOpen       — a NINE_BOX/BOTH CalibrationSession is OPEN for the cohort
const TRANSITIONS = [
  {
    event: 'authorPotential',
    from: ['DRAFT', 'PROPOSED'], // re-authoring before calibration stays PROPOSED
    to: 'PROPOSED',
    guard(ctx) {
      if (!ctx.isManagerOfSubject && !ctx.isHr) {
        return 'only the subject’s manager (or HR) may author potential';
      }
      // The perf axis must already exist — a subject pre-MANAGER_SUBMITTED can't be placed.
      if (!RATED_STATUSES.has(ctx.reviewStatus)) {
        return 'the manager review must be submitted before authoring potential';
      }
      return null;
    },
  },
  {
    event: 'move',
    from: ['PROPOSED', 'CALIBRATED'],
    to: 'CALIBRATED',
    guard(ctx) {
      // SoD: a manager can never move their OWN box (ninebox.calibrate drops self;
      // this is the in-code backstop, identical to "cannot calibrate own rating").
      if (isActor(ctx, ctx.subjectEmployeeId)) return 'SoD: the subject cannot move their own box';
      if (!ctx.isHr && !ctx.isSkipLevel) return 'only HR or the skip-level manager may move a box';
      if (!ctx.sessionOpen) return 'a 9-box calibration session must be OPEN to move a box';
      return null;
    },
  },
  {
    event: 'finalize',
    from: ['CALIBRATED', 'PROPOSED'], // HR may finalize a proposed-but-uncalibrated placement
    to: 'FINALIZED',
    guard(ctx) {
      if (!ctx.canSucceed) return 'finalize requires the talent/succession grant (canManageSuccession)';
      return null;
    },
  },
  {
    event: 'reopen',
    from: ['FINALIZED'],
    to: 'PROPOSED',
    guard(ctx) {
      if (!ctx.canSucceed && !ctx.isHr) return 'only HR may reopen a finalized placement';
      return null;
    },
  },
];

const BY_EVENT = new Map(TRANSITIONS.map((t) => [t.event, t]));

/**
 * Evaluate a transition. Returns:
 *   { ok:true,  to, transition }
 *   { ok:false, code:409|403, message }
 * 409 = illegal from-state; 403 = guard (SoD / role) rejection.
 */
function evaluate(event, fromStatus, ctx = {}) {
  const t = BY_EVENT.get(event);
  if (!t) return { ok: false, code: 400, message: `unknown event ${event}` };
  if (!t.from.includes(fromStatus)) {
    return { ok: false, code: 409, message: `cannot ${event} from ${fromStatus}` };
  }
  const reason = t.guard({ ...ctx, fromStatus });
  if (reason) return { ok: false, code: 403, message: reason };
  return { ok: true, to: t.to, transition: t };
}

function legalEvents(fromStatus) {
  return TRANSITIONS.filter((t) => t.from.includes(fromStatus)).map((t) => t.event);
}

module.exports = { STATUS, RATED_STATUSES, TRANSITIONS, evaluate, legalEvents };
