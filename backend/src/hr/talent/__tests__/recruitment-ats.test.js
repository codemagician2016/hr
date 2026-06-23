'use strict';

/**
 * recruitment-ats.test.js — Feature 12 (Recruitment / ATS) proof.
 *
 * Plain-node runner (no jest), mirroring the F4 onboarding harness:
 *   PART A (DB-FREE) — the PURE scoring engine (scoring.js): screening auto-score
 *     (CS-degree yes=marks/no=0), knockout, qualification points, multi-interviewer
 *     weighted scorecard aggregation (MEAN/MAX/MEDIAN/TRIMMED_MEAN), and the merit
 *     blend (incl. renormalise-on-missing-component + knockout→0).
 *   PART B (LIVE hr_test) — the controller seams: screening answers auto-score +
 *     knockout auto-rejects; a 3-skill scorecard submit aggregates a weighted
 *     interviewScore; the merit list ranks by combined score; and the Hired
 *     hand-off seeds an onboarding journey (reusing acceptOffer→seedOnboardingJourney).
 *
 * Run (PART B needs the live schema):
 *   DATABASE_URL="$HR_URL" node src/hr/talent/__tests__/recruitment-ats.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

const scoring = require('../recruitment/scoring');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); } }
const close = (a, b, eps = 0.05) => Math.abs(Number(a) - Number(b)) <= eps;

// ═══════════════════════════════════════════════════════════════════════════
// PART A — PURE SCORING ENGINE (no DB)
// ═══════════════════════════════════════════════════════════════════════════
function partA() {
  log('\n=== PART A — scoring.js (pure, DB-free) ===\n');

  const questions = [
    { id: 'q1', prompt: 'Do you have a Computer Science engineering degree?', kind: 'SINGLE_CHOICE',
      options: [{ value: 'yes', label: 'Yes', points: 20 }, { value: 'no', label: 'No', points: 0 }] },
    { id: 'q2', prompt: 'Highest qualification', kind: 'QUALIFICATION',
      options: [{ value: 'master', label: "Master's", points: 6 }, { value: 'bachelor', label: "Bachelor's", points: 4 }] },
    { id: 'q3', prompt: 'Eligible to work in NZ?', kind: 'BOOLEAN', isKnockout: true, knockoutValue: [true],
      options: [{ value: 'true', label: 'Yes', points: 0 }, { value: 'false', label: 'No', points: 0 }] },
  ];

  log('A1) screening auto-score (CS yes=20/no=0, qualification points, knockout):');
  {
    const yes = scoring.scoreScreening(questions, [
      { questionId: 'q1', answerValue: 'yes' }, { questionId: 'q2', answerValue: 'master' }, { questionId: 'q3', answerValue: true },
    ]);
    assert(yes.score === 26 && yes.max === 26, `CS yes + Master = 26/26 (got ${yes.score}/${yes.max})`);
    assert(yes.knockedOut === false, 'passes the NZ knockout');

    const no = scoring.scoreScreening(questions, [
      { questionId: 'q1', answerValue: 'no' }, { questionId: 'q2', answerValue: 'bachelor' }, { questionId: 'q3', answerValue: false },
    ]);
    assert(no.score === 4, `CS no(0) + Bachelor(4) = 4 (got ${no.score})`);
    assert(no.knockedOut === true, 'fails the NZ knockout → knockedOut=true');
    assert(no.knockouts.failed === 1 && no.knockouts.passed === 0, 'knockout tally: 1 failed, 0 passed');
  }

  log('A2) unanswered required knockout fails closed:');
  {
    const r = scoring.scoreScreening(questions, [{ questionId: 'q1', answerValue: 'yes' }]); // q3 not answered
    assert(r.knockedOut === true, 'missing knockout answer → knockedOut');
  }

  log('A3) scorecard weighted total + multi-interviewer aggregation:');
  {
    // 3 skills weighted 2/1/1 on a 1–10 scale.
    const cardA = { id: 'a', status: 'SUBMITTED', interviewerEmployeeId: 'E1', ratings: [
      { skillId: 's1', weight: 2, score: 8, scaleMin: 1, scaleMax: 10 },
      { skillId: 's2', weight: 1, score: 6, scaleMin: 1, scaleMax: 10 },
      { skillId: 's3', weight: 1, score: 10, scaleMin: 1, scaleMax: 10 },
    ] };
    const cardB = { id: 'b', status: 'SUBMITTED', interviewerEmployeeId: 'E2', ratings: [
      { skillId: 's1', weight: 2, score: 7, scaleMin: 1, scaleMax: 10 },
      { skillId: 's2', weight: 1, score: 9, scaleMin: 1, scaleMax: 10 },
      { skillId: 's3', weight: 1, score: 8, scaleMin: 1, scaleMax: 10 },
    ] };
    // cardA: rescaled = (8-1)/9=77.78, (6-1)/9=55.56, (10-1)/9=100; weighted (2,1,1)/4
    //        = (77.78*2 + 55.56 + 100)/4 = 77.78
    const tA = scoring.weightedCardTotal(cardA.ratings);
    assert(close(tA, 77.78), `cardA weighted total ≈ 77.78 (got ${tA})`);

    const mean = scoring.scoreInterview([cardA, cardB], { aggregation: 'MEAN' });
    assert(mean.interviewers === 2, 'two submitted cards counted');
    assert(close(mean.score, (tA + scoring.weightedCardTotal(cardB.ratings)) / 2), `MEAN aggregates both (got ${mean.score})`);

    const max = scoring.scoreInterview([cardA, cardB], { aggregation: 'MAX' });
    assert(close(max.score, Math.max(tA, scoring.weightedCardTotal(cardB.ratings))), `MAX takes the higher card (got ${max.score})`);

    // DRAFT cards never count.
    const draftOnly = scoring.scoreInterview([{ ...cardA, status: 'DRAFT' }], { aggregation: 'MEAN' });
    assert(draftOnly.score === null && draftOnly.interviewers === 0, 'DRAFT cards excluded → interviewScore null');

    // weight normalisation guard: all-zero weights → equal weighting, no div-by-zero.
    const zero = scoring.weightedCardTotal([
      { skillId: 'x', weight: 0, score: 10, scaleMin: 1, scaleMax: 10 },
      { skillId: 'y', weight: 0, score: 1, scaleMin: 1, scaleMax: 10 },
    ]);
    assert(close(zero, 50), `Σweight=0 → equal weights (10 & 1 → ~50) (got ${zero})`);
  }

  log('A4) merit blend (40/60), renormalise-on-missing, knockout→0:');
  {
    const m = scoring.computeMeritScore({ screeningScore: 26, screeningMax: 26, interviewScore: 80, knockedOut: false }, { applicationWeightPct: 40, interviewWeightPct: 60 });
    assert(close(m.merit, 40 * 1 + 60 / 100 * 80), `merit = 40%*100 + 60%*80 = 88 (got ${m.merit})`);

    // no interview yet → blend renormalises to application-only.
    const pending = scoring.computeMeritScore({ screeningScore: 13, screeningMax: 26, interviewScore: null, knockedOut: false }, { applicationWeightPct: 40, interviewWeightPct: 60 });
    assert(close(pending.merit, 50), `interview pending → app% only = 50 (got ${pending.merit})`);
    assert(pending.breakdown.interviewPending === true, 'breakdown flags interviewPending');

    // no screening config → blend renormalises to interview-only.
    const noScreen = scoring.computeMeritScore({ screeningScore: 0, screeningMax: 0, interviewScore: 70, knockedOut: false }, { applicationWeightPct: 40, interviewWeightPct: 60 });
    assert(close(noScreen.merit, 70), `no screening → interview only = 70 (got ${noScreen.merit})`);

    const ko = scoring.computeMeritScore({ screeningScore: 4, screeningMax: 26, interviewScore: 90, knockedOut: true }, { applicationWeightPct: 40, interviewWeightPct: 60 });
    assert(ko.merit === 0, `knockout → merit 0 (got ${ko.merit})`);
    assert(ko.breakdown.knockedOut === true, 'breakdown flags the knockout (never silently buried)');
  }

  log('A5) recomputeApplicationScore orchestrator builds the full snapshot:');
  {
    const job = { applicationWeightPct: 40, interviewWeightPct: 60, scorecardAggregation: 'MEAN' };
    const cards = [{ id: 'a', status: 'SUBMITTED', interviewerEmployeeId: 'E1', ratings: [
      { skillId: 's1', weight: 1, score: 9, scaleMin: 1, scaleMax: 10 },
    ] }];
    const out = scoring.recomputeApplicationScore({}, questions, [
      { questionId: 'q1', answerValue: 'yes' }, { questionId: 'q2', answerValue: 'master' }, { questionId: 'q3', answerValue: true },
    ], cards, job);
    assert(out.screeningScore === 26 && out.knockedOut === false, 'snapshot screening = 26, not knocked out');
    assert(out.interviewScore != null && out.meritScore != null, 'snapshot carries interview + merit');
    assert(out.scoreSnapshot && out.scoreSnapshot.screening && out.scoreSnapshot.interview && typeof out.scoreSnapshot.formula === 'string',
      'snapshot has explainable screening/interview sections + formula text');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PART B — LIVE hr_test
// ═══════════════════════════════════════════════════════════════════════════
function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { this.ended = true; return this; },
  };
}
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return done(); };
    const origJson = res.json.bind(res); res.json = (p) => { const r = origJson(p); done(); return r; };
    const origEnd = res.end.bind(res); res.end = () => { const r = origEnd(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const PREFIX = 'ATS-TEST';

async function partB() {
  log('\n=== PART B — LIVE hr_test (controller seams) ===\n');
  const prisma = require('../../../core/lib/prisma');
  const spine = require('../controllers/recruitment.controller');
  const s = require('../recruitment/recruitment.scoring.controller');
  const { seedOnboardingTemplates } = require('../../lifecycle/templates/seed');

  // Find-or-create a tenant + IN entity so the suite runs against a fully-seeded
  // staging DB OR a fresh isolated hr_test schema (no external seed dependency).
  let demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) {
    demo = await prisma.business.create({ data: { name: 'ATS Test Co', slug: `ats-test-${Date.now()}` } });
  }
  const businessId = demo.id;
  let entity = await prisma.entity.findFirst({ where: { businessId } });
  if (!entity) {
    entity = await prisma.entity.create({ data: {
      businessId, code: `${PREFIX}-IN-HQ`, legalName: 'ATS Test Pvt Ltd', countryCode: 'IN',
      payCurrency: 'INR', timezone: 'Asia/Kolkata', activeFrom: new Date('2024-01-01'),
    } });
  }
  const entityId = entity ? entity.id : null;
  const op = { id: 'op-user', businessId, role: 'BUSINESS_ADMIN' };

  async function cleanup() {
    const jobs = await prisma.job.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
    const jobIds = jobs.map((j) => j.id);
    const apps = await prisma.application.findMany({ where: { businessId, candidate: { email: { startsWith: PREFIX } } }, select: { id: true } });
    const appIds = apps.map((a) => a.id);
    if (appIds.length) {
      const ivs = await prisma.interview.findMany({ where: { businessId, applicationId: { in: appIds } }, select: { id: true } });
      const ivIds = ivs.map((i) => i.id);
      if (ivIds.length) {
        const cards = await prisma.scorecard.findMany({ where: { businessId, interviewId: { in: ivIds } }, select: { id: true } });
        if (cards.length) await prisma.scorecardRating.deleteMany({ where: { scorecardId: { in: cards.map((c) => c.id) } } });
        await prisma.scorecard.deleteMany({ where: { businessId, interviewId: { in: ivIds } } });
        await prisma.interview.deleteMany({ where: { id: { in: ivIds } } });
      }
      await prisma.screeningAnswer.deleteMany({ where: { businessId, applicationId: { in: appIds } } });
      const offers = await prisma.offer.findMany({ where: { businessId, applicationId: { in: appIds } }, select: { id: true } });
      if (offers.length) await prisma.lifecycleJourney.deleteMany({ where: { businessId, offerId: { in: offers.map((o) => o.id) } } });
      await prisma.offer.deleteMany({ where: { businessId, applicationId: { in: appIds } } });
      await prisma.application.deleteMany({ where: { id: { in: appIds } } });
    }
    if (jobIds.length) {
      await prisma.screeningOption.deleteMany({ where: { businessId, question: { jobId: { in: jobIds } } } });
      await prisma.screeningQuestion.deleteMany({ where: { businessId, jobId: { in: jobIds } } });
      await prisma.jobStage.deleteMany({ where: { businessId, jobId: { in: jobIds } } });
      await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
    }
    await prisma.candidate.deleteMany({ where: { businessId, email: { startsWith: PREFIX } } });
    await prisma.scorecardSkill.deleteMany({ where: { businessId, template: { name: { startsWith: PREFIX } } } });
    await prisma.scorecardTemplate.deleteMany({ where: { businessId, name: { startsWith: PREFIX } } });
    await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
    const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
    if (emps.length) {
      await prisma.lifecycleTask.deleteMany({ where: { businessId, assigneeEmployeeId: { in: emps.map((e) => e.id) } } });
      await prisma.scorecard.deleteMany({ where: { businessId, interviewerEmployeeId: { in: emps.map((e) => e.id) } } });
    }
    await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  }

  await cleanup();
  try {
    await seedOnboardingTemplates(prisma, businessId, { entityId });

    // ── Build the scorecard template (3 weighted skills) ──
    const tplRes = await callController(s.createScorecardTemplate, { user: op, body: {
      name: `${PREFIX} Tech Round`, aggregation: 'MEAN',
      skills: [
        { name: 'Data Structures', weight: 2, scaleMin: 1, scaleMax: 10, sortOrder: 0 },
        { name: 'System Design', weight: 1, scaleMin: 1, scaleMax: 10, sortOrder: 1 },
        { name: 'Communication', weight: 1, scaleMin: 1, scaleMax: 10, sortOrder: 2 },
      ],
    } });
    assert(tplRes.statusCode === 201 && tplRes.body.skills.length === 3, 'B0) scorecard template with 3 skills created');
    const template = tplRes.body;

    // ── Post a job with the merit blend + default scorecard template ──
    const jobRes = await callController(spine.createJob, { user: op, body: {
      code: `${PREFIX}-JOB`, title: 'Backend Engineer', countryCode: 'IN', employmentType: 'FULL_TIME',
      entityId, applicationWeightPct: 40, interviewWeightPct: 60, scorecardTemplateId: template.id, status: 'OPEN',
    } });
    assert(jobRes.statusCode === 201, 'B1) job created with 40/60 merit blend');
    const job = jobRes.body;

    // merit weights must sum to 100
    const badWeights = await callController(spine.createJob, { user: op, body: {
      code: `${PREFIX}-JOB2`, title: 'X', countryCode: 'IN', employmentType: 'FULL_TIME', applicationWeightPct: 30, interviewWeightPct: 60,
    } });
    assert(badWeights.statusCode === 400, 'B1b) merit weights that do not sum to 100 are rejected (400)');

    // ── Pipeline stages (SCREENING + INTERVIEW + REJECTED) ──
    for (const [i, st] of [['Screened', 'SCREENING'], ['Interview', 'INTERVIEW'], ['Rejected', 'REJECTED']].entries()) {
      await callController(spine.createStage, { user: op, params: { jobId: job.id }, body: { name: st[0], kind: st[1], sortOrder: i } });
    }

    // ── Screening questions (knockout + qualification points) ──
    const q1Res = await callController(s.createScreeningQuestion, { user: op, params: { jobId: job.id }, body: {
      prompt: 'Do you have a CS engineering degree?', kind: 'SINGLE_CHOICE',
      options: [{ label: 'Yes', value: 'yes', points: 20 }, { label: 'No', value: 'no', points: 0 }],
    } });
    const q2Res = await callController(s.createScreeningQuestion, { user: op, params: { jobId: job.id }, body: {
      prompt: 'Highest qualification', kind: 'QUALIFICATION',
      options: [{ label: "Master's", value: 'master', points: 6 }, { label: "Bachelor's", value: 'bachelor', points: 4 }],
    } });
    const q3Res = await callController(s.createScreeningQuestion, { user: op, params: { jobId: job.id }, body: {
      prompt: 'Eligible to work in NZ?', kind: 'BOOLEAN', isKnockout: true, knockoutValue: [true],
      options: [{ label: 'Yes', value: 'true', points: 0 }, { label: 'No', value: 'false', points: 0 }],
    } });
    assert([q1Res, q2Res, q3Res].every((r) => r.statusCode === 201), 'B2) 3 screening questions created (1 knockout, 1 qualification)');
    const q1 = q1Res.body; const q2 = q2Res.body; const q3 = q3Res.body;

    // helper to spin up a candidate + application
    async function applyCandidate(tag) {
      const cand = await prisma.candidate.create({ data: { businessId, firstName: tag, lastName: 'C', email: `${PREFIX}-${tag}@x.com` } });
      const appRes = await callController(spine.createApplication, { user: op, body: { jobId: job.id, candidateId: cand.id } });
      return { cand, app: appRes.body };
    }

    // ── B3: screening answers auto-score; passing candidate lands in SCREENING ──
    log('B3) screening answers auto-score + stage move:');
    const alice = await applyCandidate('alice');
    const aliceAns = await callController(s.submitScreeningAnswers, { user: op, params: { id: alice.app.id }, body: { answers: [
      { questionId: q1.id, answerValue: 'yes' }, { questionId: q2.id, answerValue: 'master' }, { questionId: q3.id, answerValue: true },
    ] } });
    assert(aliceAns.statusCode === 200 && Number(aliceAns.body.screeningScore) === 26, `alice screening = 26/26 (got ${aliceAns.body.screeningScore})`);
    assert(aliceAns.body.knockedOut === false, 'alice not knocked out');
    const aliceApp = await prisma.application.findUnique({ where: { id: alice.app.id } });
    assert(aliceApp.status === 'SCREENING', `alice moved to SCREENING stage (got ${aliceApp.status})`);

    // ── B4: knockout answer auto-rejects ──
    log('B4) knockout answer auto-rejects:');
    const bob = await applyCandidate('bob');
    const bobAns = await callController(s.submitScreeningAnswers, { user: op, params: { id: bob.app.id }, body: { answers: [
      { questionId: q1.id, answerValue: 'no' }, { questionId: q2.id, answerValue: 'bachelor' }, { questionId: q3.id, answerValue: false },
    ] } });
    assert(bobAns.body.knockedOut === true, 'bob knocked out');
    const bobApp = await prisma.application.findUnique({ where: { id: bob.app.id } });
    assert(bobApp.status === 'REJECTED' && /knockout/i.test(bobApp.rejectReason || ''), 'bob auto-moved to REJECTED with a clear reason');
    assert(Number(bobApp.meritScore || 0) === 0, 'bob merit = 0 (knockout)');

    // a second candidate to test ranking
    const carol = await applyCandidate('carol');
    await callController(s.submitScreeningAnswers, { user: op, params: { id: carol.app.id }, body: { answers: [
      { questionId: q1.id, answerValue: 'yes' }, { questionId: q2.id, answerValue: 'bachelor' }, { questionId: q3.id, answerValue: true },
    ] } }); // 24/26

    // ── B5: schedule interviews, fill + submit scorecards (interviewer ESS, SoD) ──
    log('B5) interviewer scorecard submit aggregates a weighted interviewScore:');
    // two panellist employees
    const e1 = await prisma.employee.create({ data: { businessId, code: `${PREFIX}-E1`, firstName: 'Int1', lastName: 'V', status: 'ACTIVE' } });
    const e2 = await prisma.employee.create({ data: { businessId, code: `${PREFIX}-E2`, firstName: 'Int2', lastName: 'V', status: 'ACTIVE' } });

    const ivRes = await callController(spine.createInterview, { user: op, body: {
      applicationId: alice.app.id, round: 1, mode: 'VIDEO', interviewerIds: `${e1.id},${e2.id}`, scorecardTemplateId: template.id, scheduledAt: '2026-07-01T10:00:00Z',
    } });
    assert(ivRes.statusCode === 201, 'interview scheduled');
    const interview = ivRes.body;
    const blankCards = await prisma.scorecard.findMany({ where: { businessId, interviewId: interview.id } });
    assert(blankCards.length === 2, `one blank DRAFT scorecard pre-created per interviewer (got ${blankCards.length})`);

    const skills = template.skills; // [DS w2, SysDesign w1, Comm w1]
    // interviewer 1 (bound to e1) fills + submits their card
    const e1User = { id: 'u-e1', businessId, role: 'USER', employeeId: e1.id };
    const card1 = await callController(s.myScorecard, { user: e1User, params: { interviewId: interview.id } });
    assert(card1.statusCode === 200, 'e1 can open their own scorecard');
    await callController(s.saveMyScorecard, { user: e1User, params: { id: card1.body.card.id }, body: { ratings: [
      { skillId: skills[0].id, score: 8 }, { skillId: skills[1].id, score: 6 }, { skillId: skills[2].id, score: 10 },
    ], recommendation: 'YES' } });
    const sub1 = await callController(s.submitMyScorecard, { user: e1User, params: { id: card1.body.card.id }, body: {} });
    assert(sub1.statusCode === 200 && sub1.body.status === 'SUBMITTED', 'e1 submits their card');

    // SoD: e2 cannot open/submit e1's card
    const e2User = { id: 'u-e2', businessId, role: 'USER', employeeId: e2.id };
    const e2OnE1 = await callController(s.saveMyScorecard, { user: e2User, params: { id: card1.body.card.id }, body: { ratings: [] } });
    assert(e2OnE1.statusCode === 404, 'SoD: e2 cannot touch e1\'s scorecard (404)');

    // a non-panellist employee sees nothing for this interview
    const e3 = await prisma.employee.create({ data: { businessId, code: `${PREFIX}-E3`, firstName: 'Int3', lastName: 'V', status: 'ACTIVE' } });
    const e3User = { id: 'u-e3', businessId, role: 'USER', employeeId: e3.id };
    const e3Card = await callController(s.myScorecard, { user: e3User, params: { interviewId: interview.id } });
    assert(e3Card.statusCode === 404, 'a non-panellist cannot open a scorecard for this interview (404)');

    // interviewer 2 fills + submits
    const card2 = await callController(s.myScorecard, { user: e2User, params: { interviewId: interview.id } });
    await callController(s.saveMyScorecard, { user: e2User, params: { id: card2.body.card.id }, body: { ratings: [
      { skillId: skills[0].id, score: 7 }, { skillId: skills[1].id, score: 9 }, { skillId: skills[2].id, score: 8 },
    ], recommendation: 'STRONG_YES' } });
    await callController(s.submitMyScorecard, { user: e2User, params: { id: card2.body.card.id }, body: {} });

    const aliceScored = await prisma.application.findUnique({ where: { id: alice.app.id } });
    assert(aliceScored.interviewScore != null && Number(aliceScored.interviewScore) > 0, `alice interviewScore aggregated (got ${aliceScored.interviewScore})`);
    assert(aliceScored.meritScore != null && Number(aliceScored.meritScore) > 0, `alice meritScore computed (got ${aliceScored.meritScore})`);

    // submitted card is locked (cannot edit without HR reopen)
    const lockTry = await callController(s.saveMyScorecard, { user: e1User, params: { id: card1.body.card.id }, body: { ratings: [] } });
    assert(lockTry.statusCode === 409, 'submitted scorecard is locked (409 on edit)');

    // ── B6: merit list ranks by combined score; KO/pending segregated ──
    log('B6) merit list ranks by combined score:');
    const merit = await callController(s.meritList, { user: op, params: { jobId: job.id }, query: {} });
    assert(merit.statusCode === 200, 'merit list returns 200');
    assert(merit.body.ranked.length >= 1 && merit.body.ranked[0].candidate, 'ranked list has alice (interviewed)');
    assert(merit.body.ranked[0].rank === 1, 'top candidate has rank 1');
    assert(merit.body.knockedOut.some((a) => a.knockedOut || a.status === 'REJECTED'), 'bob sits in the knocked-out section');
    assert(merit.body.pending.some((a) => a.id === carol.app.id), 'carol (not yet interviewed) sits in pending');
    assert(typeof merit.body.job.formula === 'string' && /40/.test(merit.body.job.formula), 'merit list prints the exact formula');

    // every ranked row carries the explainable snapshot
    assert(merit.body.ranked[0].scoreSnapshot && merit.body.ranked[0].scoreSnapshot.screening && merit.body.ranked[0].scoreSnapshot.interview,
      '"Why this rank?" snapshot present on the ranked row');

    // ── B7: Hired hand-off seeds an onboarding journey (reuse acceptOffer seam) ──
    log('B7) offer accept → onboarding journey seeded (Hired hand-off):');
    const offerRes = await callController(spine.createOffer, { user: op, body: {
      applicationId: alice.app.id, currencyCode: 'INR', grossMonthly: 100000, basicMonthly: 55000, joiningDate: '2026-08-01',
    } });
    assert(offerRes.statusCode === 201, 'offer created (50% wage check passes for 55% basic)');
    await callController(spine.sendOffer, { user: op, params: { id: offerRes.body.id }, body: {} });
    const acc = await callController(spine.acceptOffer, { user: op, params: { id: offerRes.body.id }, body: {} });
    assert(acc.statusCode === 200, 'offer accepted → 200');
    const hiredApp = await prisma.application.findUnique({ where: { id: alice.app.id } });
    assert(hiredApp.status === 'HIRED', 'application flipped to HIRED');
    const journeys = await prisma.lifecycleJourney.findMany({ where: { businessId, offerId: offerRes.body.id } });
    assert(journeys.length === 1 && journeys[0].direction === 'ONBOARDING', 'exactly one onboarding journey seeded from the hire');

    // ── B8: scorecard-template delete blocked when referenced by a future interview ──
    log('B8) template delete guarded by a scheduled interview (409):');
    {
      const del = await callController(s.removeScorecardTemplate, { user: op, params: { id: template.id }, body: {} });
      assert(del.statusCode === 409, 'cannot delete a template used by a scheduled interview (409)');
    }
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

async function main() {
  partA();
  if (process.env.DATABASE_URL && /schema=hr_test/.test(process.env.DATABASE_URL)) {
    try { await partB(); }
    catch (e) { failures += 1; log('  FAIL  PART B threw:', e.message); console.error(e); }
  } else {
    log('\n(skipping PART B — set DATABASE_URL with ?schema=hr_test to run the live seams)\n');
  }
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
