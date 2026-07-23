'use strict';

/**
 * candidateTimeline.js — Feature 36 candidate status/timeline PURE logic.
 *
 * The public status page (GET /careers/:slug/c/:token) maps an Application.status
 * onto a FRIENDLY, non-numeric label and projects ONLY the fields a candidate may
 * see. This module owns both, side-effect-free, so the disclosure rule is tested
 * in one place: it must NEVER surface a score (merit/screening/interview),
 * scoreSnapshot, reject-reason internals, interviewer identities, other
 * candidates, or a knockedOut flag (§4.6, same rule the public apply enforces).
 */

// ApplicationStatus → { stageLabel, nextStep }. The six in §4.6 are verbatim; the
// remaining enum values (ASSESSMENT/WITHDRAWN/ON_HOLD) get sensible neutral copy.
const STATUS_LABELS = Object.freeze({
  APPLIED: { stageLabel: 'Application received', nextStep: "We've received your application and our team will review it." },
  SCREENING: { stageLabel: 'Under review', nextStep: 'Your application is being reviewed.' },
  ASSESSMENT: { stageLabel: 'Assessment stage', nextStep: 'Please complete any assessment shared with you.' },
  INTERVIEWING: { stageLabel: 'Interview stage', nextStep: "We'll be in touch about interview scheduling." },
  OFFERED: { stageLabel: 'Offer extended', nextStep: 'Please review the offer we sent you.' },
  HIRED: { stageLabel: 'Offer accepted', nextStep: 'Welcome aboard — onboarding details will follow.' },
  REJECTED: { stageLabel: 'Not selected this time', nextStep: 'Thank you for your interest. We encourage you to apply again in future.' },
  WITHDRAWN: { stageLabel: 'Application withdrawn', nextStep: 'This application is no longer active.' },
  ON_HOLD: { stageLabel: 'On hold', nextStep: 'This application is currently on hold.' },
});

const DEFAULT_LABEL = Object.freeze({ stageLabel: 'In progress', nextStep: '' });

// Map a raw ApplicationStatus to its friendly label bundle (never a number).
function friendlyStatus(status) {
  return STATUS_LABELS[status] || DEFAULT_LABEL;
}

// The EXACT set of fields that must never leave the tenant boundary to a
// candidate. Kept explicit so the unit test can assert every one is absent.
const FORBIDDEN_FIELDS = Object.freeze([
  'meritScore', 'screeningScore', 'screeningMaxScore', 'interviewScore',
  'scoreSnapshot', 'rejectReason', 'knockedOut', 'rating',
  'currentStageId', 'convertedEmployeeId', 'candidateId', 'businessId', 'jobId',
  'interviews', 'interviewers', 'interviewerIds', 'offers', 'scorecards',
]);

// Project ONE application row into the candidate-safe timeline shape. `role` is
// the job title (resolved by the caller from the joined job). Returns ONLY
// { role, stageLabel, appliedAt, lastUpdateAt, nextStep } — no scores, no PII,
// no other candidate, no internal ids.
function serializeTimelineApplication(app, { role } = {}) {
  const labels = friendlyStatus(app && app.status);
  return {
    role: role || (app && app.job && app.job.title) || 'the role',
    stageLabel: labels.stageLabel,
    nextStep: labels.nextStep,
    appliedAt: app && app.createdAt ? new Date(app.createdAt).toISOString() : null,
    lastUpdateAt: app && app.updatedAt ? new Date(app.updatedAt).toISOString() : null,
  };
}

module.exports = {
  STATUS_LABELS,
  friendlyStatus,
  serializeTimelineApplication,
  FORBIDDEN_FIELDS,
};
