'use strict';

/*
 * candidateTimeline.unit.test.js — Feature 36 friendly status mapper + the
 * no-score-leak timeline projection (§4.6). Plain-node, no DB:
 *   node backend/src/hr/talent/recruitment/__tests__/candidateTimeline.unit.test.js
 */

const assert = require('assert');
const {
  friendlyStatus, serializeTimelineApplication, FORBIDDEN_FIELDS, STATUS_LABELS,
} = require('../candidateTimeline');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

/* ── friendly status label map (§4.6 verbatim) ── */
{
  ok('APPLIED → Application received', friendlyStatus('APPLIED').stageLabel === 'Application received');
  ok('SCREENING → Under review', friendlyStatus('SCREENING').stageLabel === 'Under review');
  ok('INTERVIEWING → Interview stage', friendlyStatus('INTERVIEWING').stageLabel === 'Interview stage');
  ok('OFFERED → Offer extended', friendlyStatus('OFFERED').stageLabel === 'Offer extended');
  ok('HIRED → Offer accepted', friendlyStatus('HIRED').stageLabel === 'Offer accepted');
  ok('REJECTED → Not selected this time', friendlyStatus('REJECTED').stageLabel === 'Not selected this time');
  // extra enum values still get a non-empty, neutral label
  ok('ASSESSMENT labelled', !!friendlyStatus('ASSESSMENT').stageLabel);
  ok('WITHDRAWN labelled', !!friendlyStatus('WITHDRAWN').stageLabel);
  ok('ON_HOLD labelled', !!friendlyStatus('ON_HOLD').stageLabel);
  // unknown → default, never throws
  ok('unknown → default label', friendlyStatus('SOMETHING_NEW').stageLabel === 'In progress');
  ok('null → default label', friendlyStatus(null).stageLabel === 'In progress');
}

/* ── labels are FRIENDLY (non-numeric) — no score ever leaks through a label ── */
{
  const allLabels = Object.values(STATUS_LABELS).map((l) => l.stageLabel);
  ok('no label contains a digit', allLabels.every((l) => !/\d/.test(l)));
}

/* ── no-score-leak projection: a FULL application row (with every forbidden score
 *    / PII / internal field) must project to ONLY the 5 safe keys ── */
{
  const fullApp = {
    id: 'app-1',
    businessId: 'biz-1',
    jobId: 'job-1',
    candidateId: 'cand-1',
    status: 'INTERVIEWING',
    currentStageId: 'stage-9',
    rating: 4.5,
    rejectReason: 'internal: weak system design',
    convertedEmployeeId: null,
    meritScore: 87.5,
    screeningScore: 30,
    screeningMaxScore: 40,
    interviewScore: 72,
    knockedOut: false,
    scoreSnapshot: { why: 'ranked #2', panel: ['emp-1', 'emp-2'] },
    interviews: [{ id: 'iv-1', interviewerIds: 'emp-1,emp-2' }],
    offers: [{ id: 'of-1' }],
    createdAt: new Date('2026-07-01T10:00:00.000Z'),
    updatedAt: new Date('2026-07-05T09:30:00.000Z'),
    job: { title: 'Senior Backend Engineer' },
  };

  const out = serializeTimelineApplication(fullApp, { role: fullApp.job.title });

  // exactly the safe shape
  ok('role surfaced', out.role === 'Senior Backend Engineer');
  ok('friendly stageLabel', out.stageLabel === 'Interview stage');
  ok('has nextStep', typeof out.nextStep === 'string');
  ok('appliedAt ISO', out.appliedAt === '2026-07-01T10:00:00.000Z');
  ok('lastUpdateAt ISO', out.lastUpdateAt === '2026-07-05T09:30:00.000Z');
  ok('output has exactly 5 keys', Object.keys(out).sort().join(',') === 'appliedAt,lastUpdateAt,nextStep,role,stageLabel');

  // EVERY forbidden field is absent from the projection
  for (const f of FORBIDDEN_FIELDS) {
    ok(`forbidden field absent: ${f}`, !(f in out));
  }
  // belt-and-braces: no numeric score value anywhere in the serialized output
  const serialized = JSON.stringify(out);
  ok('no meritScore value leaked', !serialized.includes('87.5'));
  ok('no interviewScore value leaked', !serialized.includes('72'));
  ok('no reject-reason internals leaked', !/weak system design/.test(serialized));
  ok('no interviewer id leaked', !/emp-1/.test(serialized));
}

/* ── role falls back to job.title, else a neutral default ── */
{
  const a = { status: 'APPLIED', createdAt: new Date(), updatedAt: new Date(), job: { title: 'QA Lead' } };
  ok('role from job.title when not passed', serializeTimelineApplication(a).role === 'QA Lead');
  const b = { status: 'APPLIED', createdAt: new Date(), updatedAt: new Date() };
  ok('role default when no job', serializeTimelineApplication(b).role === 'the role');
}

console.log(`candidateTimeline.unit: ${passed} checks passed`);
