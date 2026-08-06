'use strict';

/**
 * recruitment-enhancements.test.js — Feature 12 enhancement proof.
 *
 * Plain-node runner (no jest), same harness as recruitment-ats.test.js.
 *   PART A (DB-FREE) — the pure publicCareersLink builder + applicationFilterWhere
 *     translation + scopeApplicationWhere intersection.
 *   PART B (LIVE hr_test) — the controller seams:
 *     1. Shareable public link: getJob/shareJob expose a resolvable careers URL +
 *        the public apply route; a candidate applies via the resolved slug and the
 *        response NEVER leaks the score (thank-you only).
 *     2. Server-side filters return the right subset (status, stage, source, score
 *        range, knockout, free-text).
 *     3. Bulk shortlist/reject over a FILTER changes only the in-scope filtered
 *        candidates; an out-of-scope candidate is untouched; an explicit id list is
 *        intersected with the scoped set.
 *     4. Job funnel summary counts each stage + computes time-to-fill.
 *     5. Close-job records the reason; FILLED outcome flips status to FILLED.
 *
 * Run (PART B needs the live schema):
 *   DATABASE_URL="$HR_URL" node src/hr/talent/recruitment/__tests__/recruitment-enhancements.test.js
 */

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); } }

const spine = require('../../controllers/recruitment.controller');
const { publicCareersLink, applicationFilterWhere, scopeApplicationWhere } = spine._internals;

// ═══════════════════════════════════════════════════════════════════════════
// PART A — DB-FREE
// ═══════════════════════════════════════════════════════════════════════════
function partA() {
  log('\n=== PART A — pure (DB-free) ===\n');

  log('A1) publicCareersLink builds a resolvable careers + apply path:');
  {
    const link = publicCareersLink('acme', { publicSlug: 'backend-engineer-eng-001', isPublic: true, status: 'OPEN' });
    assert(link && link.jobPath === '/careers/acme/jobs/backend-engineer-eng-001', `jobPath built (got ${link && link.jobPath})`);
    // Must include the trailing /apply — the route is
    // POST /api/public/careers/:businessSlug/jobs/:publicSlug/apply. Asserting it
    // without /apply passed a URL that FETCHES the job to anything wiring a
    // direct application POST.
    assert(link.apiApplyPath === '/api/public/careers/acme/jobs/backend-engineer-eng-001/apply', `apiApplyPath points at the unauth apply route (got ${link.apiApplyPath})`);
    assert(link.careersPath === '/careers/acme', 'careersPath points at the tenant board');
    assert(link.live === true, 'OPEN + isPublic → link is LIVE');
    // a DRAFT public job is NOT live yet
    const draft = publicCareersLink('acme', { publicSlug: 's', isPublic: true, status: 'DRAFT' });
    assert(draft.live === false, 'DRAFT public job → not live');
    // no slug → null bundle
    assert(publicCareersLink('acme', { publicSlug: null, isPublic: true, status: 'OPEN' }) === null, 'no publicSlug → null link');
    assert(publicCareersLink(null, { publicSlug: 's' }) === null, 'no business slug → null link');
  }

  log('A2) applicationFilterWhere translates every filter:');
  {
    const w = applicationFilterWhere({
      status: 'SCREENING', stageId: 'st1', source: 'PUBLIC', knockout: 'false',
      minScore: '40', maxScore: '90', from: '2026-01-01', to: '2026-12-31', skill: 'jane',
    });
    assert(w.status === 'SCREENING', 'status mapped');
    assert(w.currentStageId === 'st1', 'stageId → currentStageId');
    assert(w.appliedSource === 'PUBLIC', 'source → appliedSource');
    assert(w.knockedOut === false, "knockout 'false' → knockedOut false");
    assert(w.meritScore.gte === 40 && w.meritScore.lte === 90, 'score range → meritScore gte/lte');
    assert(w.createdAt.gte instanceof Date && w.createdAt.lte instanceof Date, 'date range → createdAt gte/lte');
    assert(w.candidate && w.candidate.is && Array.isArray(w.candidate.is.OR), 'free-text → candidate name/email OR');
    // knockout 'true'
    assert(applicationFilterWhere({ knockout: 'true' }).knockedOut === true, "knockout 'true' → knockedOut true");
    // empty filter → empty where
    assert(Object.keys(applicationFilterWhere({})).length === 0, 'empty filter → no constraints');
  }

  log('A3) scopeApplicationWhere intersects with the F1 reach:');
  {
    // ALL band → unchanged
    const allW = scopeApplicationWhere({ businessId: 'b' }, { all: true }, undefined);
    assert(allW.jobId === undefined, 'ALL band → no jobId restriction');
    // scoped, no caller jobId → restricted to the reachable ids
    const scoped = scopeApplicationWhere({}, { all: false, ids: ['j1', 'j2'] }, undefined);
    assert(Array.isArray(scoped.jobId.in) && scoped.jobId.in.length === 2, 'scoped → jobId in reach.ids');
    // scoped + an out-of-reach caller jobId → match-nothing
    const oob = scopeApplicationWhere({}, { all: false, ids: ['j1'] }, 'jX');
    assert(Array.isArray(oob.jobId.in) && oob.jobId.in.length === 0, 'out-of-reach jobId → match-nothing');
    // scoped + an in-reach caller jobId → that job only
    const inr = scopeApplicationWhere({}, { all: false, ids: ['j1', 'j2'] }, 'j2');
    assert(inr.jobId === 'j2', 'in-reach jobId → that job only');
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

const PREFIX = 'ATS-ENH';

async function partB() {
  log('\n=== PART B — LIVE hr_test (controller seams) ===\n');
  const prisma = require('../../../../core/lib/prisma');
  const pc = require('../publicCareers.controller');

  // tenant with a known slug so the public board resolves it.
  let demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) demo = await prisma.business.findFirst({ where: { slug: { startsWith: 'ats-test-' } } });
  if (!demo) demo = await prisma.business.create({ data: { name: 'ATS Enh Co', slug: `ats-enh-${Date.now()}` } });
  const businessId = demo.id;
  const businessSlug = demo.slug;
  const op = { id: 'op-enh', businessId, role: 'BUSINESS_ADMIN' };
  const ALL_SCOPE = { kind: 'ALL' };
  const withScope = (req) => ({ recruitmentScope: ALL_SCOPE, ...req });

  async function cleanup() {
    const jobs = await prisma.job.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
    const jobIds = jobs.map((j) => j.id);
    // emails are stored lowercased by the public apply path — match case-insensitively.
    const apps = await prisma.application.findMany({ where: { businessId, candidate: { email: { contains: PREFIX, mode: 'insensitive' } } }, select: { id: true } });
    const appIds = apps.map((a) => a.id);
    if (appIds.length) {
      const offers = await prisma.offer.findMany({ where: { businessId, applicationId: { in: appIds } }, select: { id: true } });
      if (offers.length) await prisma.lifecycleJourney.deleteMany({ where: { businessId, offerId: { in: offers.map((o) => o.id) } } });
      await prisma.offer.deleteMany({ where: { businessId, applicationId: { in: appIds } } });
      await prisma.screeningAnswer.deleteMany({ where: { businessId, applicationId: { in: appIds } } });
      await prisma.application.deleteMany({ where: { id: { in: appIds } } });
    }
    if (jobIds.length) {
      await prisma.screeningOption.deleteMany({ where: { businessId, question: { jobId: { in: jobIds } } } });
      await prisma.screeningQuestion.deleteMany({ where: { businessId, jobId: { in: jobIds } } });
      await prisma.jobStage.deleteMany({ where: { businessId, jobId: { in: jobIds } } });
      await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
    }
    await prisma.candidate.deleteMany({ where: { businessId, email: { contains: PREFIX, mode: 'insensitive' } } });
  }

  await cleanup();
  try {
    // ── Post a job + stages ──
    const jobRes = await callController(spine.createJob, withScope({ user: op, body: {
      code: `${PREFIX}-JOB`, title: 'Platform Engineer', countryCode: 'IN', employmentType: 'FULL_TIME', status: 'OPEN',
    } }));
    assert(jobRes.statusCode === 201, 'B0) job created');
    const job = jobRes.body;
    const stageKinds = [['Sourced', 'SOURCED'], ['Screened', 'SCREENING'], ['Interview', 'INTERVIEW'], ['Offer', 'OFFER'], ['Hired', 'HIRED'], ['Rejected', 'REJECTED']];
    const stageByKind = {};
    for (const [i, st] of stageKinds.entries()) {
      const r = await callController(spine.createStage, { user: op, params: { jobId: job.id }, body: { name: st[0], kind: st[1], sortOrder: i } });
      stageByKind[st[1]] = r.body;
    }

    // ── B1: shareable public link ──
    log('B1) shareable public link resolves + publish toggle:');
    const setPub = await callController(spine.setJobPublic, withScope({ user: op, params: { id: job.id }, body: { isPublic: true } }));
    assert(setPub.statusCode === 200 && setPub.body.isPublic === true, 'set-public flips isPublic on');
    assert(setPub.body.publicSlug, `a public slug was auto-derived (got ${setPub.body.publicSlug})`);
    assert(setPub.body.publicLink && setPub.body.publicLink.jobPath === `/careers/${businessSlug}/jobs/${setPub.body.publicSlug}`, 'set-public returns the careers job path');
    assert(setPub.body.publicLink.live === true, 'OPEN + public → link LIVE');
    const publicSlug = setPub.body.publicSlug;

    const share = await callController(spine.shareJob, withScope({ user: op, params: { id: job.id } }));
    assert(share.statusCode === 200 && share.body.publicLink.apiApplyPath === `/api/public/careers/${businessSlug}/jobs/${publicSlug}/apply`, 'shareJob returns the apply API path');

    const getJ = await callController(spine.getJob, withScope({ user: op, params: { id: job.id } }));
    assert(getJ.body.publicLink && getJ.body.publicLink.publicSlug === publicSlug, 'getJob embeds the publicLink bundle');

    // ── B1b: a candidate applies via the resolved public slug — NO score leak ──
    log('B1b) public apply via the link never leaks the score:');
    const applyRes = await callController(pc.publicApply, {
      ip: '203.0.113.7',
      params: { businessSlug, publicSlug },
      body: { firstName: 'Pub', lastName: 'Applicant', email: `${PREFIX}-pub@x.com`, consent: true },
    });
    assert(applyRes.statusCode === 201 && applyRes.body.ok === true, 'public apply returns a 201 thank-you');
    const leaked = JSON.stringify(applyRes.body);
    assert(!/score|merit|knock|rank/i.test(leaked), 'apply response NEVER serialises score/merit/knockout');
    // emails are lowercased on store — query case-insensitively.
    const pubApp = await prisma.application.findFirst({ where: { businessId, jobId: job.id, candidate: { email: { equals: `${PREFIX}-pub@x.com`, mode: 'insensitive' } } } });
    assert(pubApp && pubApp.appliedSource === 'PUBLIC', 'the public application landed (appliedSource=PUBLIC)');
    // the public app is auto-moved onto the job's SCREENING stage (no questions →
    // not knocked out); exclude it from the seeded-candidate filter assertions below.
    const pubAppId = pubApp ? pubApp.id : null;

    // helper to seed a candidate + application at a given status/stage. `source` is
    // the ApplicationSource enum value used for BOTH the appliedSource filter column
    // and the candidate.source label.
    async function seed(tag, status, stageKind, source = 'MANUAL', knockedOut = false, merit = null) {
      const cand = await prisma.candidate.create({ data: { businessId, firstName: tag, lastName: 'X', email: `${PREFIX}-${tag}@x.com`, source } });
      const app = await prisma.application.create({ data: {
        businessId, jobId: job.id, candidateId: cand.id, status,
        currentStageId: stageByKind[stageKind] ? stageByKind[stageKind].id : null,
        appliedSource: source, knockedOut, meritScore: merit,
      } });
      return { cand, app };
    }
    const alice = await seed('alice', 'APPLIED', 'SOURCED', 'MANUAL', false, 80);
    const bob = await seed('bob', 'SCREENING', 'SCREENING', 'REFERRAL', false, 55);
    const carol = await seed('carol', 'SCREENING', 'SCREENING', 'MANUAL', true, 0); // knocked out
    const dave = await seed('dave', 'APPLIED', 'SOURCED', 'MANUAL', false, 30);

    // ── B2: server-side filters ──
    log('B2) server-side filters return the right subset:');
    const byStatus = await callController(spine.listApplications, withScope({ user: op, query: { jobId: job.id, status: 'SCREENING' } }));
    const statusIds = byStatus.body.items.map((a) => a.id);
    assert(statusIds.includes(bob.app.id) && statusIds.includes(carol.app.id) && !statusIds.includes(alice.app.id), 'status=SCREENING returns only the screening apps');

    const byScore = await callController(spine.listApplications, withScope({ user: op, query: { jobId: job.id, minScore: '50' } }));
    const scoreIds = byScore.body.items.map((a) => a.id);
    assert(scoreIds.includes(alice.app.id) && scoreIds.includes(bob.app.id) && !scoreIds.includes(dave.app.id), 'minScore=50 excludes the low-merit app');

    const byKnock = await callController(spine.listApplications, withScope({ user: op, query: { jobId: job.id, knockout: 'true' } }));
    assert(byKnock.body.items.length === 1 && byKnock.body.items[0].id === carol.app.id, 'knockout=true returns only the knocked-out app');

    const bySource = await callController(spine.listApplications, withScope({ user: op, query: { jobId: job.id, source: 'REFERRAL' } }));
    assert(bySource.body.items.length === 1 && bySource.body.items[0].id === bob.app.id, 'source=REFERRAL returns only bob');

    const byText = await callController(spine.listApplications, withScope({ user: op, query: { jobId: job.id, skill: 'alice' } }));
    assert(byText.body.items.length === 1 && byText.body.items[0].candidate.firstName === 'alice', 'free-text matches the candidate name');
    assert(byStatus.body.pagination && typeof byStatus.body.pagination.total === 'number', 'list is paginated (pagination block present)');

    // ── B3: bulk shortlist over a filter changes only the in-scope filtered set ──
    log('B3) bulk shortlist/reject over a filter (scoped):');
    // count who is currently in SCREENING (bob + carol + the public applicant).
    const screeningNow = await prisma.application.count({ where: { businessId, jobId: job.id, status: 'SCREENING' } });
    // shortlist everyone currently in SCREENING → INTERVIEWING.
    const bulkShort = await callController(spine.bulkApplicationAction, withScope({ user: op, body: {
      action: 'shortlist', filter: { jobId: job.id, status: 'SCREENING' },
    } }));
    assert(bulkShort.statusCode === 200 && bulkShort.body.changed === screeningNow, `bulk shortlist changed every screening app (${bulkShort.body.changed}/${screeningNow})`);
    const bobAfter = await prisma.application.findUnique({ where: { id: bob.app.id } });
    const aliceAfter = await prisma.application.findUnique({ where: { id: alice.app.id } });
    assert(bobAfter.status === 'INTERVIEWING' && bobAfter.currentStageId === stageByKind.INTERVIEW.id, 'bob shortlisted → INTERVIEWING on the INTERVIEW stage');
    assert(aliceAfter.status === 'APPLIED', 'alice (not in the filter) was UNTOUCHED');

    // reject by explicit id list (intersected with scope) — only dave.
    const bulkRej = await callController(spine.bulkApplicationAction, withScope({ user: op, body: {
      action: 'reject', filter: { jobId: job.id }, ids: [dave.app.id], reason: 'Not a fit',
    } }));
    assert(bulkRej.body.changed === 1, 'bulk reject by id changed exactly 1');
    const daveAfter = await prisma.application.findUnique({ where: { id: dave.app.id } });
    assert(daveAfter.status === 'REJECTED' && /not a fit/i.test(daveAfter.rejectReason || ''), 'dave rejected with the supplied reason');

    // set-status to ON_HOLD over the whole job; terminal apps (carol now INTERVIEWING isn't terminal) still move; rejected dave is skipped-as-terminal only for non-set-status
    const bulkHold = await callController(spine.bulkApplicationAction, withScope({ user: op, body: {
      action: 'set-status', status: 'ON_HOLD', filter: { jobId: job.id, status: 'INTERVIEWING' },
    } }));
    assert(bulkHold.body.changed >= 2, `set-status ON_HOLD moved the interviewing apps (got ${bulkHold.body.changed})`);

    // ── B3b: out-of-scope bulk cannot touch a foreign candidate ──
    log('B3b) bulk action is scope-bound (out-of-scope untouched):');
    const NONE = { recruitmentScope: { kind: 'NONE' } };
    const bulkNone = await callController(spine.bulkApplicationAction, { ...NONE, user: op, body: { action: 'reject', filter: { jobId: job.id } } });
    assert(bulkNone.body.changed === 0, 'a NONE-scope caller changes 0 (no reachable jobs)');

    // ── B4: funnel summary ──
    log('B4) per-job funnel summary counts each stage + time-to-fill:');
    const summary = await callController(spine.jobSummary, withScope({ user: op, params: { id: job.id } }));
    assert(summary.statusCode === 200, 'summary returns 200');
    const f = Object.fromEntries(summary.body.funnel.map((s) => [s.key, s.count]));
    assert(typeof f.applied === 'number' && f.applied >= f.screened, 'funnel applied ≥ screened (cumulative shape)');
    assert(summary.body.totals.total >= 5, `total counts every application (got ${summary.body.totals.total})`);
    assert(summary.body.totals.rejected >= 1, 'rejected tally includes dave');
    assert(summary.body.totals.knockedOut >= 1, 'knocked-out tally includes carol');
    assert('days' in summary.body.timeToFill, 'time-to-fill present');

    // ── B5: close-job records the reason ──
    log('B5) close-job records a reason + FILLED outcome:');
    const closed = await callController(spine.closeJob, withScope({ user: op, params: { id: job.id }, body: { reason: 'Budget frozen', outcome: 'CANCELLED' } }));
    assert(closed.statusCode === 200 && closed.body.status === 'CLOSED', 'close → CLOSED');
    assert(closed.body.closeReason === 'Budget frozen', 'close reason persisted');
    // a FILLED close on a fresh OPEN job flips to FILLED
    const job2Res = await callController(spine.createJob, withScope({ user: op, body: { code: `${PREFIX}-JOB2`, title: 'SRE', countryCode: 'IN', employmentType: 'FULL_TIME', status: 'OPEN' } }));
    const filled = await callController(spine.closeJob, withScope({ user: op, params: { id: job2Res.body.id }, body: { outcome: 'FILLED', reason: 'All openings met' } }));
    assert(filled.body.status === 'FILLED', 'FILLED outcome → status FILLED');
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
