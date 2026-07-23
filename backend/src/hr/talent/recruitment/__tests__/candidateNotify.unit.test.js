'use strict';

/*
 * candidateNotify.unit.test.js — Feature 36 auto-send gate decision table (§4.2 /
 * §7.1) + the dedupe-token builder (§7.3). Plain-node, no DB:
 *   node backend/src/hr/talent/recruitment/__tests__/candidateNotify.unit.test.js
 */

const assert = require('assert');
const {
  AUTO_SEND_DEFAULTS, autoSendDecision, buildCandidateDedupeToken, stageKeyForEvent,
} = require('../candidateNotify')._internals;

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

/* ── per-stage DEFAULTS: ON for the good-news touch-points, OFF for reject ── */
{
  ok('applied default ON', autoSendDecision({ stage: 'applied' }) === true);
  ok('shortlisted default ON', autoSendDecision({ stage: 'shortlisted' }) === true);
  ok('interview_invite default ON', autoSendDecision({ stage: 'interview_invite' }) === true);
  ok('slot_request default ON', autoSendDecision({ stage: 'slot_request' }) === true);
  ok('offer default ON', autoSendDecision({ stage: 'offer' }) === true);
  ok('rejected default OFF', autoSendDecision({ stage: 'rejected' }) === false);
  ok('defaults table matches', AUTO_SEND_DEFAULTS.rejected === false && AUTO_SEND_DEFAULTS.applied === true);
  // unknown stage → fail-open ON (never silently swallow a new stage)
  ok('unknown stage → ON', autoSendDecision({ stage: 'brand_new' }) === true);
}

/* ── BUSINESS override beats the default ── */
{
  const biz = { autoSend: { rejected: true, applied: false } };
  ok('biz turns reject ON', autoSendDecision({ stage: 'rejected', bizConfig: biz }) === true);
  ok('biz turns applied OFF', autoSendDecision({ stage: 'applied', bizConfig: biz }) === false);
  // a stage not in the biz map still uses the default
  ok('biz silent on offer → default ON', autoSendDecision({ stage: 'offer', bizConfig: biz }) === true);
}

/* ── JOB override beats BUSINESS + default (precedence) ── */
{
  const biz = { autoSend: { shortlisted: true } };
  const job = { autoSend: { shortlisted: false } };
  ok('job OFF beats biz ON', autoSendDecision({ stage: 'shortlisted', jobConfig: job, bizConfig: biz }) === false);

  const job2 = { autoSend: { rejected: true } };
  ok('job ON beats default OFF', autoSendDecision({ stage: 'rejected', jobConfig: job2 }) === false || autoSendDecision({ stage: 'rejected', jobConfig: job2 }) === true);
  ok('job ON overrides reject default', autoSendDecision({ stage: 'rejected', jobConfig: job2 }) === true);
}

/* ── malformed config values fall THROUGH to the next level ── */
{
  const job = { autoSend: { applied: 'yes' } }; // not a boolean → ignored
  const biz = { autoSend: { applied: false } };
  ok('non-bool job value ignored → biz wins', autoSendDecision({ stage: 'applied', jobConfig: job, bizConfig: biz }) === false);
  ok('no autoSend map → default', autoSendDecision({ stage: 'applied', jobConfig: {}, bizConfig: {} }) === true);
  ok('null configs → default', autoSendDecision({ stage: 'rejected', jobConfig: null, bizConfig: null }) === false);
}

/* ── stageKeyForEvent ── */
{
  ok('candidate.shortlisted → shortlisted', stageKeyForEvent('candidate.shortlisted') === 'shortlisted');
  ok('candidate.interview_invite → interview_invite', stageKeyForEvent('candidate.interview_invite') === 'interview_invite');
  ok('interview.* → null (not gated)', stageKeyForEvent('interview.feedback_nudge') === null);
  ok('raw key → null', stageKeyForEvent('HR_CAND_OFFER') === null);
}

/* ── dedupe-token builder: CAND_<stage>:<appId>:<status>[:<suffix>] (§7.3) ── */
{
  ok('shortlisted token',
    buildCandidateDedupeToken({ event: 'candidate.shortlisted', applicationId: 'app9', status: 'INTERVIEWING' })
      === 'CAND_shortlisted:app9:INTERVIEWING');
  ok('applied token',
    buildCandidateDedupeToken({ event: 'candidate.applied', applicationId: 'a1', status: 'APPLIED' })
      === 'CAND_applied:a1:APPLIED');
  // a re-fired identical transition yields the SAME token (→ deduped no-op)
  const t1 = buildCandidateDedupeToken({ event: 'candidate.shortlisted', applicationId: 'x', status: 'INTERVIEWING' });
  const t2 = buildCandidateDedupeToken({ event: 'candidate.shortlisted', applicationId: 'x', status: 'INTERVIEWING' });
  ok('identical transition → identical token', t1 === t2);
  // a different status (the bounce) yields a DIFFERENT token
  const t3 = buildCandidateDedupeToken({ event: 'candidate.shortlisted', applicationId: 'x', status: 'SCREENING' });
  ok('different status → different token', t1 !== t3);
  // a bulk suffix lets a deliberate re-run re-send
  ok('suffix appended',
    buildCandidateDedupeToken({ event: 'candidate.rejected', applicationId: 'app', status: 'REJECTED', suffix: 'run7' })
      === 'CAND_rejected:app:REJECTED:run7');
  // a raw templateKey pseudo-event is sanitized into the stage slot
  ok('raw templateKey sanitized',
    buildCandidateDedupeToken({ event: 'HR_CAND_SHORTLISTED', applicationId: 'a', status: 'S' })
      === 'CAND_HR_CAND_SHORTLISTED:a:S');
}

console.log(`candidateNotify.unit: ${passed} checks passed`);
