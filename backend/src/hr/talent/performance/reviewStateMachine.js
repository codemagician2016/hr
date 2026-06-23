'use strict';

/**
 * reviewStateMachine.js — Feature 8 §5.5: the review-instance state machine, a
 * PURE transition table + guard evaluator (no DB; mirrors SeparationStatus). The
 * controller wraps each call in a tx with `WHERE id AND version` (optimistic lock)
 * and writes the AuditLog row; this module only answers "is this event legal from
 * this state, for this actor, given this instance?" and "what's the next state?".
 *
 * Existing ReviewStatus enum values are kept; the machine adds release + sign-off
 * as explicit steps and fixes the three live bugs the spec found:
 *   #3a self-required: submitMgr requires status===SELF_SUBMITTED (or selfRequired
 *       false) — NOT_STARTED→MANAGER_SUBMITTED is rejected when self is required.
 *   #3b SoD: submitMgr/calibrate/signOff require actor ≠ subject.
 *   #3c release gate: signOff LOCKS finalRating but does NOT release; the org-wide
 *       releaseCycle stamps releasedAt and the ESS serializer hides it until then.
 */

const STATUS = Object.freeze({
  NOT_STARTED: 'NOT_STARTED',
  SELF_SUBMITTED: 'SELF_SUBMITTED',
  MANAGER_SUBMITTED: 'MANAGER_SUBMITTED',
  CALIBRATED: 'CALIBRATED',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
});

// CANCELLED is not in the live enum; we model it as a logical terminal kept in
// outcomeJson/status guards only where the enum allows. To stay schema-safe we
// route "cancel" to CLOSED with a cancelled flag in meta (the enum has no CANCELLED
// member for ReviewStatus — confirmed at schema.prisma §14). Callers read meta.
const ENUM_HAS_CANCELLED = false;

// ctx fields the guards read:
//   actorEmployeeId  — the acting employee (resolved from session, never trusted body)
//   subjectEmployeeId, reviewerEmployeeId — from the instance row
//   selfRequired     — cycle/scale flag (ratingScaleJson.selfRequired, default true)
//   isHr             — actor holds canManagePerformanceCycle
//   isSkipLevel      — actor is the reviewer's manager (skip-level)
//   cycleStatus      — current ReviewCycle.status
function isActor(ctx, id) {
  return id && ctx.actorEmployeeId && ctx.actorEmployeeId === id;
}

const TRANSITIONS = [
  {
    event: 'submitSelf',
    from: ['NOT_STARTED'],
    to: 'SELF_SUBMITTED',
    guard(ctx) {
      if (!isActor(ctx, ctx.subjectEmployeeId)) return 'self-review must be submitted by the subject';
      if (ctx.cycleStatus && !['ACTIVE', 'SELF_REVIEW'].includes(ctx.cycleStatus)) {
        return `cycle is ${ctx.cycleStatus}; self-review window is closed`;
      }
      return null;
    },
  },
  {
    event: 'submitMgr',
    // BUG #3b fix: if self is required, NOT_STARTED is NOT a legal source — the
    // self step must complete first. Only when selfRequired===false may a manager
    // submit from NOT_STARTED.
    from: ['SELF_SUBMITTED', 'NOT_STARTED'],
    to: 'MANAGER_SUBMITTED',
    guard(ctx) {
      if (isActor(ctx, ctx.subjectEmployeeId)) return 'SoD: a manager cannot review their own instance';
      if (ctx.reviewerEmployeeId && !isActor(ctx, ctx.reviewerEmployeeId) && !ctx.isHr) {
        return 'only the assigned reviewer (or HR) may submit the manager review';
      }
      const selfRequired = ctx.selfRequired !== false;
      if (selfRequired && ctx.fromStatus === 'NOT_STARTED') {
        return 'self-review is required before the manager review';
      }
      return null;
    },
  },
  {
    event: 'calibrate',
    from: ['MANAGER_SUBMITTED', 'CALIBRATED'],
    to: 'CALIBRATED',
    guard(ctx) {
      if (isActor(ctx, ctx.subjectEmployeeId)) return 'SoD: the subject cannot calibrate their own rating';
      if (!ctx.isHr && !ctx.isSkipLevel) return 'only HR or the skip-level manager may calibrate';
      return null;
    },
  },
  {
    event: 'signOff',
    from: ['CALIBRATED'],
    to: 'CALIBRATED', // stays CALIBRATED + locks finalRating; org-wide release sets releasedAt
    guard(ctx) {
      if (isActor(ctx, ctx.subjectEmployeeId)) return 'SoD: the subject cannot sign off their own review';
      const isReviewer = isActor(ctx, ctx.reviewerEmployeeId);
      if (!isReviewer && !ctx.isSkipLevel && !ctx.isHr) {
        return 'sign-off requires the reviewer, skip-level, or HR';
      }
      return null;
    },
  },
  {
    event: 'acknowledge',
    from: ['CALIBRATED'],
    to: 'ACKNOWLEDGED',
    guard(ctx) {
      if (!isActor(ctx, ctx.subjectEmployeeId)) return 'only the subject may acknowledge';
      if (!ctx.released) return 'review is not yet released';
      return null;
    },
  },
  {
    event: 'close',
    from: ['ACKNOWLEDGED', 'CALIBRATED'],
    to: 'CLOSED',
    guard(ctx) {
      if (!ctx.isHr) return 'only HR may close a review';
      if (!ctx.released) return 'review must be released before close';
      return null;
    },
  },
  {
    event: 'reopen',
    from: ['CALIBRATED', 'ACKNOWLEDGED', 'CLOSED'],
    to: 'MANAGER_SUBMITTED',
    guard(ctx) {
      if (!ctx.isHr) return 'only HR may reopen a review';
      return null;
    },
  },
  {
    event: 'cancel',
    from: ['NOT_STARTED', 'SELF_SUBMITTED', 'MANAGER_SUBMITTED', 'CALIBRATED', 'ACKNOWLEDGED'],
    // Enum has no CANCELLED for ReviewStatus; logical-cancel parks at CLOSED + meta.
    to: ENUM_HAS_CANCELLED ? 'CANCELLED' : 'CLOSED',
    guard(ctx) {
      if (!ctx.isHr && !ctx.separationTriggered) return 'only HR (or an F4 separation) may cancel';
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

module.exports = { STATUS, TRANSITIONS, evaluate, legalEvents, ENUM_HAS_CANCELLED };
