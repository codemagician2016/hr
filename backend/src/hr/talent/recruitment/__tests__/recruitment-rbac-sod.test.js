'use strict';

/**
 * recruitment-rbac-sod.test.js — Feature 12 review fixes (4 findings).
 *
 * Plain-node runner (no jest), same harness as recruitment-ats.test.js.
 *   PART A (DB-FREE) — the public-apply rate-limiter key hardening + no-score-leak,
 *     and the offer-approval SoD predicate edge cases that don't need a DB.
 *   PART B (LIVE hr_test) — the controller seams:
 *     1. F1 read-scope: a scoped (TEAM-band) recruiter cannot read another
 *        manager's job / candidate / application / merit list (404 / filtered).
 *     2. Offer-approval SoD: the interviewer who scored cannot send/accept that
 *        candidate's offer (403); a different approver can.
 *     3. Public apply: rate-limited per (tenant,job,email)+IP, never leaks the
 *        score, and never inlines the raw resume blob when S3 is unconfigured.
 *     4. Foreign skillId rating is rejected (422); client weight is ignored.
 *
 * Run (PART B needs the live schema):
 *   DATABASE_URL="$HR_URL" node src/hr/talent/recruitment/__tests__/recruitment-rbac-sod.test.js
 */

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); } }

// ═══════════════════════════════════════════════════════════════════════════
// PART A — DB-FREE
// ═══════════════════════════════════════════════════════════════════════════
function partA() {
  log('\n=== PART A — pure (DB-free) ===\n');
  const pc = require('../publicCareers.controller');
  const { applyRateLimited, coarseIpBucket } = pc._internals;

  log('A1) coarse IP bucketing (v4 /24, v6 /48, v4-mapped-v6 unwrap):');
  assert(coarseIpBucket('203.0.113.45') === '203.0.113.0/24', 'IPv4 → /24 bucket');
  assert(coarseIpBucket('203.0.113.99') === coarseIpBucket('203.0.113.45'), 'neighbouring v4 hosts share a bucket');
  assert(coarseIpBucket('::ffff:203.0.113.7') === '203.0.113.0/24', 'v4-mapped v6 unwraps to the v4 /24');
  assert(/\/48$/.test(coarseIpBucket('2001:db8:abcd:1234::1')), 'IPv6 → /48 bucket');

  log('A2) rate-limit throttles a single applicant rotating IPs (email dimension):');
  {
    const B = 'biz1'; const J = 'jobA'; const E = 'Spammer@Example.com';
    let blocked = 0;
    // 5 allowed per (tenant,job,email) — rotate the IP each call so ONLY the email
    // dimension can stop it. The 6th must be blocked despite a fresh IP.
    for (let i = 0; i < 7; i += 1) {
      if (applyRateLimited({ ip: `198.51.${i}.${i}`, businessId: B, jobId: J, email: E })) blocked += 1;
    }
    assert(blocked >= 2, `applicant rotating IPs is still throttled by the email dimension (blocked ${blocked}/7)`);
    // case/space variants normalise to the SAME key (cannot fork the bucket).
    assert(applyRateLimited({ ip: '198.51.9.9', businessId: B, jobId: J, email: '  spammer@example.com ' }) === true,
      'email case/whitespace variants share the applicant bucket');
  }

  log('A3) rate-limit throttles one IP rotating emails (IP dimension):');
  {
    const B = 'biz2'; const J = 'jobB';
    let blocked = 0;
    // 10 allowed per coarse-IP bucket — rotate the email each call from the SAME
    // /24 so only the IP dimension can stop it.
    for (let i = 0; i < 13; i += 1) {
      if (applyRateLimited({ ip: '192.0.2.7', businessId: B, jobId: J, email: `rotate${i}@x.com` })) blocked += 1;
    }
    assert(blocked >= 2, `one source rotating emails is throttled by the IP dimension (blocked ${blocked}/13)`);
    // a DIFFERENT /24 is a fresh bucket (the limiter is not global-deny).
    assert(applyRateLimited({ ip: '10.0.0.1', businessId: B, jobId: J, email: 'fresh@x.com' }) === false,
      'a different /24 is a fresh IP bucket');
  }

  log('A4) per-job global ceiling bounds total writes:');
  {
    const B = 'biz3'; const J = 'jobC';
    let blocked = 0;
    // 60 per (tenant,job). Vary BOTH email and IP each call so neither of those two
    // dimensions fires — only the per-job ceiling can stop the flood.
    for (let i = 0; i < 70; i += 1) {
      if (applyRateLimited({ ip: `172.16.${Math.floor(i / 4)}.${i}`, businessId: B, jobId: J, email: `u${i}@x.com` })) blocked += 1;
    }
    assert(blocked >= 5, `per-job ceiling stops a distributed flood (blocked ${blocked}/70)`);
  }

  log('A5) publicQuestion never serialises points / knockout internals:');
  {
    const q = pc._internals.publicQuestion({
      id: 'q1', prompt: 'CS degree?', kind: 'SINGLE_CHOICE', required: true, sortOrder: 0,
      isKnockout: true, knockoutValue: [true], maxPoints: 20,
      options: [{ id: 'o1', label: 'Yes', value: 'yes', points: 20, sortOrder: 0 }],
    });
    const json = JSON.stringify(q);
    assert(!/points/.test(json) && !/knockout/i.test(json) && !/maxPoints/.test(json),
      'public question carries NO points / knockout / maxPoints (score never leaked)');
    assert(q.options[0].label === 'Yes' && q.options[0].value === 'yes', 'prompts + option labels still present');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PART B — LIVE hr_test
// ═══════════════════════════════════════════════════════════════════════════
function fakeRes() {
  return {
    statusCode: 200, body: undefined, ended: false,
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

const PREFIX = 'ATS-RBAC-TEST';

async function partB() {
  log('\n=== PART B — LIVE hr_test (controller seams) ===\n');
  const prisma = require('../../../../core/lib/prisma');
  const spine = require('../../controllers/recruitment.controller');
  const s = require('../recruitment.scoring.controller');
  const { resolveAccessibleEmployeeIds } = require('../../../lib/scopeResolver');

  let demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) demo = await prisma.business.create({ data: { name: 'ATS RBAC Co', slug: `ats-rbac-${Date.now()}` } });
  const businessId = demo.id;
  let entity = await prisma.entity.findFirst({ where: { businessId } });
  if (!entity) {
    entity = await prisma.entity.create({ data: {
      businessId, code: `${PREFIX}-IN-HQ`, legalName: 'ATS RBAC Pvt Ltd', countryCode: 'IN',
      payCurrency: 'INR', timezone: 'Asia/Kolkata', activeFrom: new Date('2024-01-01'),
    } });
  }
  const entityId = entity ? entity.id : null;
  // BUSINESS_ADMIN actor → scope band ALL (the HR/admin "sees everything" baseline).
  const op = { id: 'op-rbac', businessId, role: 'BUSINESS_ADMIN' };

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

  // Mirror the route middleware: resolve req.recruitmentScope for a given actor.
  async function withScope(actor) {
    return { recruitmentScope: await resolveAccessibleEmployeeIds(actor, 'canViewHiring') };
  }

  await cleanup();
  try {
    // ── Two hiring managers (own employees), one scoped to the other's sub-tree ──
    // recruiterR owns job A; managerM owns job B. recruiterR's TEAM band is just
    // {R} (no reports) — so R can read A but NEVER B / its candidates.
    const recruiterR = await prisma.employee.create({ data: { businessId, code: `${PREFIX}-R`, firstName: 'Recruiter', lastName: 'R', status: 'ACTIVE' } });
    const managerM = await prisma.employee.create({ data: { businessId, code: `${PREFIX}-M`, firstName: 'Manager', lastName: 'M', status: 'ACTIVE' } });

    // STAFF role → LEGACY_ROLE_SCOPE = TEAM band; employeeId anchors the sub-tree.
    const rUser = { id: 'u-r', businessId, role: 'STAFF', employeeId: recruiterR.id };

    const jobA = await prisma.job.create({ data: { businessId, entityId, code: `${PREFIX}-JOBA`, title: 'Backend (R owns)', countryCode: 'IN', employmentType: 'FULL_TIME', status: 'OPEN', hiringManagerId: recruiterR.id, applicationWeightPct: 40, interviewWeightPct: 60 } });
    const jobB = await prisma.job.create({ data: { businessId, entityId, code: `${PREFIX}-JOBB`, title: 'Frontend (M owns)', countryCode: 'IN', employmentType: 'FULL_TIME', status: 'OPEN', hiringManagerId: managerM.id, applicationWeightPct: 40, interviewWeightPct: 60 } });

    const candA = await prisma.candidate.create({ data: { businessId, firstName: 'Anna', lastName: 'A', email: `${PREFIX}-anna@x.com` } });
    const candB = await prisma.candidate.create({ data: { businessId, firstName: 'Bruno', lastName: 'B', email: `${PREFIX}-bruno@x.com` } });
    const appA = await prisma.application.create({ data: { businessId, jobId: jobA.id, candidateId: candA.id, status: 'APPLIED' } });
    const appB = await prisma.application.create({ data: { businessId, jobId: jobB.id, candidateId: candB.id, status: 'APPLIED' } });

    log('B1) F1 read-scope — a scoped recruiter sees ONLY their own requisition:');
    {
      const rScope = await withScope(rUser);
      // jobs list
      const jobs = await callController(spine.listJobs, { user: rUser, query: {}, ...rScope });
      const jobIds = jobs.body.items.map((j) => j.id);
      assert(jobIds.includes(jobA.id) && !jobIds.includes(jobB.id), 'recruiter R lists job A (owned) but NOT job B (manager M)');
      // op (ALL) sees both
      const opJobs = await callController(spine.listJobs, { user: op, query: {}, ...(await withScope(op)) });
      const opIds = opJobs.body.items.map((j) => j.id);
      assert(opIds.includes(jobA.id) && opIds.includes(jobB.id), 'admin (ALL band) lists both jobs');
      // single job out-of-scope → 404
      const getB = await callController(spine.getJob, { user: rUser, params: { id: jobB.id }, ...rScope });
      assert(getB.statusCode === 404, 'recruiter R gets 404 on job B (out-of-requisition, IDOR-safe)');
    }

    log('B2) F1 read-scope — candidates / applications / merit are requisition-filtered:');
    {
      const rScope = await withScope(rUser);
      const cands = await callController(spine.listCandidates, { user: rUser, query: {}, ...rScope });
      const cIds = cands.body.items.map((c) => c.id);
      assert(cIds.includes(candA.id) && !cIds.includes(candB.id), 'recruiter R lists candidate A only (B applied to M\'s job)');
      const getCandB = await callController(spine.getCandidate, { user: rUser, params: { id: candB.id }, ...rScope });
      assert(getCandB.statusCode === 404, 'recruiter R gets 404 on candidate B (no in-scope application)');

      const apps = await callController(spine.listApplications, { user: rUser, query: {}, ...rScope });
      const aIds = apps.body.items.map((a) => a.id);
      assert(aIds.includes(appA.id) && !aIds.includes(appB.id), 'recruiter R lists application A only');
      const getAppB = await callController(spine.getApplication, { user: rUser, params: { id: appB.id }, ...rScope });
      assert(getAppB.statusCode === 404, 'recruiter R gets 404 on application B');
      // forging a jobId in the query cannot widen the scope
      const appsForge = await callController(spine.listApplications, { user: rUser, query: { jobId: jobB.id }, ...rScope });
      assert(appsForge.body.items.length === 0, 'recruiter R passing jobB in the query still gets [] (cannot widen scope)');

      const meritB = await callController(s.meritList, { user: rUser, params: { jobId: jobB.id }, query: {}, ...rScope });
      assert(meritB.statusCode === 404, 'recruiter R cannot pull job B\'s merit list (404 — no PII/score leak)');
    }

    log('B3) Offer-approval SoD — the scorer cannot send/accept their candidate\'s offer:');
    {
      // template + interview on appA, with R on the panel (R scores Anna).
      const tpl = await prisma.scorecardTemplate.create({ data: { businessId, name: `${PREFIX} Tpl`, aggregation: 'MEAN', skills: { create: [{ businessId, name: 'DS', weight: 1, scaleMin: 1, scaleMax: 10, sortOrder: 0 }] } }, include: { skills: true } });
      const iv = await prisma.interview.create({ data: { businessId, applicationId: appA.id, round: 1, mode: 'VIDEO', interviewerIds: recruiterR.id, scorecardTemplateId: tpl.id, status: 'SCHEDULED' } });
      await prisma.scorecard.create({ data: { businessId, interviewId: iv.id, interviewerEmployeeId: recruiterR.id, templateId: tpl.id, status: 'SUBMITTED', weightedTotal: 80 } });

      // an HR admin drafts the offer (createOffer doesn't need a panel link).
      const offerRes = await callController(spine.createOffer, { user: op, body: { applicationId: appA.id, currencyCode: 'INR', grossMonthly: 100000, basicMonthly: 55000, joiningDate: '2026-09-01' } });
      assert(offerRes.statusCode === 201, 'offer drafted by HR');
      const offerId = offerRes.body.id;

      // R (who scored Anna) tries to SEND → 403 SoD. R has a linked employeeId.
      const sendByScorer = await callController(spine.sendOffer, { user: { ...rUser }, params: { id: offerId }, body: {} });
      assert(sendByScorer.statusCode === 403 && sendByScorer.body.code === 'OFFER_SOD', 'scorer R is blocked from SENDING the offer (403 OFFER_SOD)');

      // a different approver (HR admin, never on the panel) CAN send.
      const sendByHr = await callController(spine.sendOffer, { user: op, params: { id: offerId }, body: {} });
      assert(sendByHr.statusCode === 200 && sendByHr.body.status === 'SENT', 'a non-scorer approver can send the offer');

      // R also cannot ACCEPT (finalise→provision) the offer they scored.
      const acceptByScorer = await callController(spine.acceptOffer, { user: { ...rUser }, params: { id: offerId }, body: {} });
      assert(acceptByScorer.statusCode === 403 && acceptByScorer.body.code === 'OFFER_SOD', 'scorer R is blocked from ACCEPTING the offer (403 OFFER_SOD)');
    }

    log('B4) Foreign skillId rating is rejected (422); client weight is ignored:');
    {
      const tpl2 = await prisma.scorecardTemplate.create({ data: { businessId, name: `${PREFIX} Tpl2`, aggregation: 'MEAN', skills: { create: [{ businessId, name: 'SysDesign', weight: 3, scaleMin: 1, scaleMax: 10, sortOrder: 0 }] } }, include: { skills: true } });
      const realSkill = tpl2.skills[0];
      // a foreign skill on a DIFFERENT template
      const otherTpl = await prisma.scorecardTemplate.create({ data: { businessId, name: `${PREFIX} Other`, aggregation: 'MEAN', skills: { create: [{ businessId, name: 'Foreign', weight: 9, scaleMin: 1, scaleMax: 10, sortOrder: 0 }] } }, include: { skills: true } });
      const foreignSkill = otherTpl.skills[0];

      const panellist = await prisma.employee.create({ data: { businessId, code: `${PREFIX}-PAN`, firstName: 'Pan', lastName: 'L', status: 'ACTIVE' } });
      const iv2 = await prisma.interview.create({ data: { businessId, applicationId: appA.id, round: 2, mode: 'VIDEO', interviewerIds: panellist.id, scorecardTemplateId: tpl2.id, status: 'SCHEDULED' } });
      const card = await prisma.scorecard.create({ data: { businessId, interviewId: iv2.id, interviewerEmployeeId: panellist.id, templateId: tpl2.id, status: 'DRAFT' } });
      const panUser = { id: 'u-pan', businessId, role: 'USER', employeeId: panellist.id };

      // foreign skillId → 422
      const forge = await callController(s.saveMyScorecard, { user: panUser, params: { id: card.id }, body: { ratings: [{ skillId: foreignSkill.id, score: 10, weight: 99 }] } });
      assert(forge.statusCode === 422, 'rating with a skillId outside the template is rejected (422)');
      const ratingsAfterForge = await prisma.scorecardRating.findMany({ where: { scorecardId: card.id } });
      assert(ratingsAfterForge.length === 0, 'no rating row was written for the forged skillId');

      // valid skillId but client-supplied weight is IGNORED — the template weight wins.
      const ok = await callController(s.saveMyScorecard, { user: panUser, params: { id: card.id }, body: { ratings: [{ skillId: realSkill.id, score: 7, weight: 99, skillName: 'HACKED' }] } });
      assert(ok.statusCode === 200, 'rating with a valid template skillId is accepted');
      const saved = await prisma.scorecardRating.findFirst({ where: { scorecardId: card.id, skillId: realSkill.id } });
      assert(saved && Number(saved.weight) === 3, `persisted weight is the TEMPLATE weight (3), not the client\'s 99 (got ${saved && saved.weight})`);
      assert(saved && saved.skillName === 'SysDesign', 'persisted skillName is the template name, not the client\'s "HACKED"');
    }

    log('B5) Public apply — no score leak + never inlines the raw resume blob:');
    {
      const pc = require('../publicCareers.controller');
      const s3 = require('../../../../core/lib/s3');
      // mark job A public with a slug
      await prisma.job.update({ where: { id: jobA.id }, data: { isPublic: true, publicSlug: `${PREFIX.toLowerCase()}-joba` } });

      // a tiny valid PDF data URL (well under the 10MB cap)
      const tinyPdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 tiny').toString('base64')}`;
      const req = {
        params: { businessSlug: demo.slug, publicSlug: `${PREFIX.toLowerCase()}-joba` },
        ip: '203.0.113.200',
        body: { firstName: 'Pub', lastName: 'Lic', email: `${PREFIX}-public@x.com`, consent: true, resumeDataUrl: tinyPdf, answers: [] },
      };
      const applyRes = await callController(pc.publicApply, req);
      if (!s3.isConfigured()) {
        assert(applyRes.statusCode === 503, 'with S3 unconfigured, a resume apply is rejected (503) — blob never inlined');
        const inlined = await prisma.candidate.findFirst({ where: { businessId, email: `${PREFIX.toLowerCase()}-public@x.com` } });
        assert(!inlined || !(inlined.resumeUrl && inlined.resumeUrl.startsWith('data:')), 'no candidate row carries a raw data: URL in resumeUrl');
      } else {
        assert(applyRes.statusCode === 201, 'with S3 configured, the apply succeeds');
        const cand = await prisma.candidate.findFirst({ where: { businessId, email: `${PREFIX.toLowerCase()}-public@x.com` } });
        assert(cand && cand.resumeUrl && !cand.resumeUrl.startsWith('data:'), 'resumeUrl is an external URL, not an inlined data: blob');
      }

      // a resume-less apply ALWAYS works and returns a thank-you only (no score).
      const req2 = {
        params: { businessSlug: demo.slug, publicSlug: `${PREFIX.toLowerCase()}-joba` },
        ip: '203.0.113.201',
        body: { firstName: 'Noresume', lastName: 'X', email: `${PREFIX}-noresume@x.com`, consent: true, answers: [] },
      };
      const applyRes2 = await callController(pc.publicApply, req2);
      assert(applyRes2.statusCode === 201, 'a resume-less public apply succeeds (201)');
      const body2 = JSON.stringify(applyRes2.body || {});
      assert(!/score/i.test(body2) && !/merit/i.test(body2) && !/knock/i.test(body2), 'the apply response is a thank-you only (no score / merit / knockout leaked)');
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
