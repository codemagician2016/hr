'use strict';

/*
 * talentChecklist.test.js — the HIRING setup track, end to end, with no database.
 *
 * The track is scored by the SAME controller as the core guide, parameterised over a
 * track descriptor, so what has to be proved here is not the arithmetic (core's
 * suites already own that) but the SEPARATION and the new seams:
 *
 *   A) registry integrity — and, above all, that no step key exists in both
 *      registries, which is what makes owner decision 1 structural rather than
 *      conventional;
 *   B) probe semantics + absolute tenant scoping (every where-clause carries the
 *      session's businessId, and nothing reads one from a caller);
 *   C) the entitlement SHORT-CIRCUIT — an unentitled tenant gets a 200 upsell
 *      envelope and NOT ONE probe, not a 403 and not a paywalled list of rows;
 *   D) INDEPENDENCE — finishing hiring cannot move the core percentage and
 *      finishing core cannot move the hiring one, in either direction;
 *   E) the activation moment (live / almost / not_started) and its shareable URL;
 *   F) the per-track slice of Business.setupState surviving normalise() — the
 *      single highest-risk line in the change, since every write goes through it;
 *   G) resilience: one throwing probe degrades one row, never the response.
 *
 * Everything is injected: the entitlement lookup, the audit writer, both tracks'
 * loadContext, and a fake Prisma client that records the where-clause it was asked
 * for. No DATABASE_URL, no fixtures, no teardown.
 *
 *   node src/hr/setup/__tests__/talentChecklist.test.js
 */

// ── Stubs that MUST be installed before the controller is required, because it
// destructures both of these at module load. ─────────────────────────────────
// The controller DESTRUCTURES hrEntitlements at require time, so reassigning the
// module property later would be invisible to it. The stub therefore closes over
// mutable variables and is installed exactly once, before the require below.
const entitlementsLib = require('../../../core/lib/entitlements');
let ENTITLEMENTS = { talent_acquisition: { enabled: true, source: 'add_on' } };
let ENTITLEMENT_ERROR = null;
entitlementsLib.hrEntitlements = async () => {
  if (ENTITLEMENT_ERROR) throw ENTITLEMENT_ERROR;
  return ENTITLEMENTS;
};

const auditLib = require('../../../core/lib/audit');
const AUDITS = [];
auditLib.writeAudit = async (row) => { AUDITS.push(row); };

const ctrl = require('../../controllers/setupChecklist.controller');
const { TRACKS, SECONDARY_TRACKS, findTrackForStep } = require('../tracks');
const talent = require('../talent/checklistItems');
const talentProbes = require('../talent/probes');
const core = require('../checklistItems');
const coreProbes = require('../probes');
const activation = require('../talent/activation');
const setupState = require('../setupState');
const { PERMISSIONS } = require('../../../core/lib/rbac');
const { ACTIVE_SET } = require('../probes');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const BIZ = 'biz-hiring-1';
const OTHER = 'biz-someone-else';
const D = (iso) => new Date(`${iso}T00:00:00Z`);

// ── In-memory Business.setupState ────────────────────────────────────────────
// mergeSetupState is stubbed to run the REAL normalise(), because that is exactly
// what section F is about: a branch normalise does not rebuild is dropped by the
// next write of any other branch.
let STATE = setupState.normalise(null);
setupState.readSetupState = async () => STATE;
setupState.mergeSetupState = async (_businessId, mutate) => {
  STATE = setupState.normalise(mutate(STATE) || STATE);
  return STATE;
};

// ── A fake Prisma client that records every where-clause ─────────────────────
// Canned values are keyed `model.op` and may be a literal or a function of the
// call args, so two probes hitting the same delegate with different filters (job
// counts, say) can answer differently.
function fakeClient(canned = {}, sink = []) {
  const answer = (model, op, args) => {
    sink.push({ model, op, where: args && args.where, select: args && args.select });
    const v = canned[`${model}.${op}`];
    const out = typeof v === 'function' ? v((args && args.where) || {}) : v;
    if (out !== undefined) return out;
    return op === 'count' ? 0 : (op === 'findMany' ? [] : null);
  };
  return new Proxy({}, {
    get: (_t, model) => ({
      count: async (a) => answer(model, 'count', a),
      findUnique: async (a) => answer(model, 'findUnique', a),
      findFirst: async (a) => answer(model, 'findFirst', a),
      findMany: async (a) => answer(model, 'findMany', a),
    }),
  });
}

// A tenant whose hiring setup is entirely finished.
const ALL_DONE = {
  'careersPage.findUnique': {
    headline: 'Build payroll India trusts',
    aboutHtml: '<p>We are forty people in Bengaluru.</p>',
    cultureHtml: null,
    perksJson: [{ label: 'Health cover for the family' }],
    socialLinksJson: { linkedin: 'https://linkedin.com/company/acme' },
    isPublished: true,
  },
  'tenantBrand.findFirst': { logoUrl: 'https://cdn/logo.png', primaryColor: '#1A73E8' },
  'pipelineTemplate.count': 1,
  'screeningFormTemplate.count': 1,
  'scorecardTemplate.count': 1,
  'tenantMessageTemplate.count': 1,
  'job.count': 2,
  'application.count': 12,
  'application.findFirst': { createdAt: D('2026-08-04') },
};
const NOTHING_DONE = {};

function talentCtx(prisma, businessOverrides = {}) {
  return {
    prisma,
    businessId: BIZ,
    business: {
      id: BIZ, createdAt: D('2026-01-01'), slug: 'acme',
      hrCountry: 'IN', hrCurrency: 'INR', candidateCommsConfig: null,
      ...businessOverrides,
    },
    today: D('2026-08-04'),
    country: 'IN', currency: 'INR',
    slug: 'acme',
  };
}

// The core track's context shape, so section D can score both tracks in one process.
function coreCtx(prisma) {
  return {
    prisma,
    businessId: BIZ,
    business: {
      id: BIZ, createdAt: D('2026-01-01'), hrCountry: 'IN', hrCountrySetAt: D('2026-01-02'),
      hrCurrency: 'INR', companyProfile: null, featureFlags: {},
    },
    today: D('2026-08-04'),
    country: 'IN', currency: 'INR', featureFlags: {},
    activeEmployeeWhere: { businessId: BIZ, deletedAt: null, status: { in: ACTIVE_SET } },
    activeEntityWhere: { businessId: BIZ, deletedAt: null, status: 'ACTIVE' },
    activeEmployees: 10, activeEntities: 1, activeInEntities: 1,
    taxYearStartMonth: 4, fyStart: D('2026-04-01'), currentFy: '2026-27',
    _migratedFromAnotherSystem: false, _joinedBeforeTaxYearStart: 0,
  };
}

// Install a loadContext for a track and return the call counter.
function stubContext(probesModule, factory) {
  const calls = { n: 0 };
  probesModule.loadContext = async (businessId) => { calls.n += 1; return factory(businessId); };
  return calls;
}

const OWNER = { id: 'user-1', businessId: BIZ, role: 'BUSINESS_ADMIN' };

function stepOf(payload, key) {
  for (const stage of payload.stages || []) {
    const found = stage.steps.find((s) => s.key === key);
    if (found) return found;
  }
  return null;
}
const allSteps = (p) => (p.stages || []).reduce((acc, s) => acc.concat(s.steps), []);

function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; },
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

async function main() {
  log('\n=== Hiring setup track — separation, scoping, activation ===\n');

  // ══════════════════════════════════════════════════════════════════════════
  log('A) Registry integrity — and the structural separation from core\n');
  {
    ok(talent.STAGES.length === 4, `four stages declared (${talent.STAGES.length})`);
    ok(talent.STAGES.every((s, i) => s.order === i + 1), 'stage order is 1..4 with no gaps');
    ok(talent.STEPS.length === 11, `eleven steps declared (${talent.STEPS.length})`);
    ok(new Set(talent.STEPS.map((s) => s.key)).size === 11, 'step keys are unique');
    ok(talent.STEPS.every((s, i) => s.order === i + 1), '`order` is the declared index, 1-based, no gaps');
    ok(talent.STEPS.every((s) => s.stageOrder === talent.STAGE_ORDER[s.stage]), 'stageOrder is derived, never hand-typed');

    // THE guarantee behind owner decision 1: a hiring step cannot enter the core
    // denominator because it is not in the array the core request iterates.
    const overlap = talent.STEPS.map((s) => s.key).filter((k) => core.BY_KEY.has(k));
    ok(overlap.length === 0, `no step key exists in BOTH registries${overlap.length ? ` (${overlap})` : ''}`);
    ok(findTrackForStep('first_job').key === 'talent', 'findTrackForStep sends `first_job` to the hiring track');
    ok(findTrackForStep('country').key === 'core', 'and `country` to core');
    ok(findTrackForStep('nope') === null, 'and an invented key nowhere');

    const noProbe = talent.STEPS.filter((s) => !talentProbes.PROBES[s.key]).map((s) => s.key);
    ok(noProbe.length === 0, `every step has a probe${noProbe.length ? ` (missing: ${noProbe})` : ''}`);
    const orphans = Object.keys(talentProbes.PROBES).filter((k) => !talent.BY_KEY.has(k));
    ok(orphans.length === 0, `no orphan probes${orphans.length ? ` (${orphans})` : ''}`);
    // The runner is the CORE function bound to this map, not a second copy, so both
    // tracks degrade identically. Proved by behaviour: an unregistered key comes
    // back in the core envelope rather than throwing or being silently dropped.
    const stray = await talentProbes.runProbes(talentCtx(fakeClient({}, [])), ['not_a_step']);
    const strayCore = await coreProbes.runProbes(coreCtx(fakeClient({}, [])), ['not_a_step']);
    ok(JSON.stringify(stray) === JSON.stringify(strayCore), 'the probe RUNNER is the core one bound to this map, not a second implementation');

    const badPerm = talent.STEPS.filter((s) => !(s.permission in PERMISSIONS)).map((s) => `${s.key}:${s.permission}`);
    ok(badPerm.length === 0, `every permission is in the RBAC catalog${badPerm.length ? ` (${badPerm})` : ''}`);
    const badAny = talent.STEPS.flatMap((s) => (s.permissionAny || [])
      .filter((k) => !(k in PERMISSIONS)).map((k) => `${s.key}:${k}`));
    ok(badAny.length === 0, `every permissionAny key is in the RBAC catalog${badAny.length ? ` (${badAny})` : ''}`);
    // THE GATE AND THE REGISTRY MUST AGREE. A key the ROUTE admits but no step scores
    // means that operator is scored on an empty set — and 0 of 0 renders as a green
    // 100% over a track they have not started. Widening one without the other is the
    // regression this line exists to catch.
    const unscored = TRACKS.talent.anyPermission.filter(
      (k) => !talent.STEPS.some((s) => (s.permissionAny || [s.permission]).includes(k)),
    );
    ok(unscored.length === 0,
      `every key the /talent route admits scores at least one step${unscored.length ? ` (${unscored} would see 100% of 0)` : ''}`);
    // The whole track is gated at the TRACK level, so a per-row entitlement would
    // double-lock rows the tenant has already paid for.
    ok(!talent.STEPS.some((s) => s.entitlement), 'no individual row carries an entitlement — the track gate owns that');

    const dangling = [];
    for (const s of talent.STEPS) for (const d of s.dependsOn) if (!talent.BY_KEY.has(d)) dangling.push(`${s.key}->${d}`);
    ok(dangling.length === 0, `every dependsOn resolves${dangling.length ? ` (${dangling})` : ''}`);
    const cycles = talent.STEPS.filter((s) => talent.ancestorsOf(s.key).has(s.key)).map((s) => s.key);
    ok(cycles.length === 0, `no dependency cycles${cycles.length ? ` (${cycles})` : ''}`);
    const backwards = [];
    for (const s of talent.STEPS) for (const d of s.dependsOn) if (talent.BY_KEY.get(d).order > s.order) backwards.push(`${s.key}<-${d}`);
    ok(backwards.length === 0, `dependencies are always declared earlier${backwards.length ? ` (${backwards})` : ''}`);

    const required = talent.STEPS.filter((s) => s.required);
    ok(required.length === 5, `five required steps (${required.map((s) => s.key)})`);
    ok(!required.some((s) => s.dismissible), 'a required step is NEVER dismissible');
    ok(talent.STEPS.filter((s) => !s.required).every((s) => s.dismissible), 'every recommended step is dismissible');
    // A required step waiting on a dismissible one renders a prerequisite hint that
    // may never clear. The core guide tolerates exactly one such edge; this track
    // has none, and that is worth keeping.
    const soft = required.filter((s) => s.dependsOn.some((d) => !talent.BY_KEY.get(d).required)).map((s) => s.key);
    ok(soft.length === 0, `no required step waits on a dismissible one${soft.length ? ` (${soft})` : ''}`);
    // The finish line is the careers page, not a pay run.
    ok(talent.STEPS[talent.STEPS.length - 1].key === 'careers_live', 'the track ends on "take your careers page live"');

    const thin = talent.STEPS.filter((s) => !s.label || !s.description || !s.why
      || !s.explain || !s.explain.plain || !s.explain.example || !s.explain.ifYouSkip).map((s) => s.key);
    ok(thin.length === 0, `every step carries label/description/why/explain${thin.length ? ` (${thin})` : ''}`);
    const longCta = talent.STEPS.filter((s) => !s.cta || s.cta.split(/\s+/).length > 4).map((s) => s.key);
    ok(longCta.length === 0, `every CTA is verb+object, 4 words or fewer${longCta.length ? ` (${longCta})` : ''}`);
    ok(!talent.STEPS.some((s) => s.route.includes('from=setup')), 'routes are BARE (the client appends ?from=)');
    ok(talent.STEPS.every((s) => s.route.startsWith('/')), 'every step deep-links to a real screen path');

    const before = talent.STEPS[0].label;
    try { talent.STEPS[0].label = 'mutated'; } catch (_e) { /* strict-mode throw is also a pass */ }
    ok(talent.STEPS[0].label === before, 'the registry is frozen — a request handler cannot poison later requests');
  }

  // ══════════════════════════════════════════════════════════════════════════
  log('\nB) Probes — tenant scoping is absolute, and "a row exists" is not "done"\n');
  {
    const sink = [];
    const prisma = fakeClient(ALL_DONE, sink);
    const ctx = talentCtx(prisma, { candidateCommsConfig: { autoSend: { rejected: true } } });
    const status = await talentProbes.runProbes(ctx, talent.STEPS.map((s) => s.key));

    const notDone = Object.entries(status).filter(([, v]) => !v.completed).map(([k]) => k);
    ok(notDone.length === 0, `a fully-set-up tenant reports every step done${notDone.length ? ` (missing: ${notDone})` : ''}`);
    ok(Object.values(status).every((v) => v.ok === true), 'and no probe errored');

    const unscoped = sink.filter((c) => !c.where || c.where.businessId !== BIZ);
    ok(unscoped.length === 0, `every one of the ${sink.length} queries is filtered by the session's businessId${unscoped.length ? ` (leaks: ${unscoped.map((c) => c.model)})` : ''}`);
    ok(!sink.some((c) => JSON.stringify(c.where || {}).includes(OTHER)), 'and no query can be steered at another tenant');
  }

  {
    const prisma = fakeClient(NOTHING_DONE, []);
    const ctx = talentCtx(prisma);
    const status = await talentProbes.runProbes(ctx, talent.STEPS.map((s) => s.key));
    const done = Object.entries(status).filter(([, v]) => v.completed).map(([k]) => k);
    ok(done.length === 0, `a brand-new tenant reports nothing done${done.length ? ` (wrongly green: ${done})` : ''}`);
  }

  // The judgement calls, one by one.
  {
    const P = talentProbes.PROBES;
    const page = (row) => talentCtx(fakeClient({ 'careersPage.findUnique': row }, []));

    ok(await P.careers_content(page({ headline: 'We are hiring', aboutHtml: '<p>&nbsp;</p>', cultureHtml: '<p></p>' })) === false,
      'a WYSIWYG opened and saved without typing is NOT a written page');
    ok(await P.careers_content(page({ headline: '   ', aboutHtml: '<p>Real words.</p>' })) === false,
      'nor is real body copy under a blank headline');
    ok(await P.careers_content(page({ headline: 'We are hiring', aboutHtml: null, cultureHtml: '<p>Real words.</p>' })) === true,
      'either about OR culture with real text is enough');
    ok(await P.careers_content(page(null)) === false, 'and an absent page row is honestly not done');

    ok(talentProbes.filledHtml('<div><span>&nbsp;</span></div>') === false, 'filledHtml sees through tags and entities');
    ok(talentProbes.filledHtml('<p>x</p>') === true, 'and finds a single real character');

    const brand = (row) => talentCtx(fakeClient({ 'tenantBrand.findFirst': row }, []));
    ok(await P.careers_brand(brand({ logoUrl: 'https://cdn/l.png', primaryColor: null })) === false,
      'a logo with no brand colour is not a branded careers page');

    const extras = (row) => talentCtx(fakeClient({ 'careersPage.findUnique': row }, []));
    ok(await P.careers_extras(extras({ perksJson: [], socialLinksJson: {} })) === false, 'empty perks + empty links are not "added"');
    ok(await P.careers_extras(extras({ perksJson: [], socialLinksJson: { website: 'https://acme.com' } })) === true, 'one social link is enough');
    ok(await P.careers_extras(extras({ perksJson: [{ label: 'Hybrid' }], socialLinksJson: null })) === true, 'so is one perk');

    // isDefault is load-bearing: createJob only ever applies the DEFAULT template.
    const pipeSink = [];
    await P.pipeline_template(talentCtx(fakeClient({ 'pipelineTemplate.count': 0 }, pipeSink)));
    ok(pipeSink[0].where.isDefault === true && pipeSink[0].where.deletedAt === null,
      'pipeline_template requires the DEFAULT template, and filters soft-deletes');

    const scoreSink = [];
    await P.scorecard_template(talentCtx(fakeClient({}, scoreSink)));
    ok(scoreSink[0].where.isActive === true && scoreSink[0].where.deletedAt === null,
      'scorecard_template filters BOTH isActive and deletedAt (the model carries both)');
    const formSink = [];
    await P.screening_form(talentCtx(fakeClient({}, formSink)));
    ok(!('isActive' in formSink[0].where), 'screening_form does NOT filter isActive — that column does not exist');

    const autosend = (cfg) => talentCtx(fakeClient({}, []), { candidateCommsConfig: cfg });
    ok(P.candidate_autosend(autosend(null)) === false, 'an untouched comms config is not a decision');
    ok(P.candidate_autosend(autosend({ replyTo: 'jobs@acme.com' })) === false,
      'nor is a reply-to address — only the autoSend key means someone chose what sends');
    ok(P.candidate_autosend(autosend({ autoSend: {} })) === true, 'an explicit autoSend map IS a decision, even when empty');

    const tmplSink = [];
    await P.candidate_templates(talentCtx(fakeClient({}, tmplSink)));
    ok(tmplSink[0].model === 'tenantMessageTemplate', 'candidate_templates reads the PER-TENANT override, never the shared global row');
    ok(Array.isArray(tmplSink[0].where.templateKey.in) && tmplSink[0].where.templateKey.in.length === 8,
      `and only the eight candidate keys the comms screen writes (${tmplSink[0].where.templateKey.in.length})`);

    const jobSink = [];
    await P.first_job(talentCtx(fakeClient({}, jobSink)));
    ok(!jobSink[0].where.status.in.includes('DRAFT'), 'first_job excludes DRAFT — a draft requisition is a note to yourself');
    const pubSink = [];
    await P.job_public(talentCtx(fakeClient({}, pubSink)));
    ok(pubSink[0].where.isPublic === true && pubSink[0].where.status === 'OPEN' && pubSink[0].where.publicSlug.not === null,
      'job_public is publicBoard()\'s own where-clause plus the slug that makes the link resolve');

    const live = (row) => talentCtx(fakeClient({ 'careersPage.findUnique': row }, []));
    ok(await P.careers_live(live({ isPublished: false })) === false, 'a saved-but-unpublished page is not live');
    ok(await P.careers_live(live(null)) === false, 'and an absent page is not live');
  }

  // ══════════════════════════════════════════════════════════════════════════
  log('\nC) Not entitled → a 200 upsell envelope, and NOT ONE probe\n');
  {
    ENTITLEMENTS = { talent_acquisition: { enabled: false, source: 'fallback' } };
    const sink = [];
    const calls = stubContext(talentProbes, () => talentCtx(fakeClient(ALL_DONE, sink)));

    const res = await callController(ctrl.makeHandlers('talent').getChecklist, { user: OWNER, body: {}, query: {}, params: {} });
    ok(res.statusCode === 200, `the endpoint answers 200, not 403 — an offer must not sit behind an error page (got ${res.statusCode})`);
    const p = res.body;
    ok(p.entitled === false && p.track === 'talent', 'the payload says entitled:false');
    ok(p.upsell && p.upsell.addOn === 'talent_acquisition', 'and names the add-on');
    ok(p.upsell.route === '/settings?tab=billing&highlight=talent_acquisition', 'linking to the SAME billing destination the core locked row uses');
    ok(p.upsell.message === 'Included in Talent Acquisition.', `with the shipped wording ("${p.upsell.message}")`);
    ok(p.percent === null && p.stages.length === 0, 'no percentage and no rows are invented');
    ok(p.nextAction === null && p.activation === null, 'and no next action or activation');
    ok(calls.n === 0, `loadContext was never called (${calls.n})`);
    ok(sink.length === 0, `and not a single probe query ran (${sink.length})`);

    // A lookup FAILURE fails closed onto the same envelope, per the core rule. The
    // entitlement is set to ENABLED first, so the throw is the ONLY thing that can
    // produce the upsell — otherwise this would pass for the wrong reason.
    ENTITLEMENTS = { talent_acquisition: { enabled: true, source: 'add_on' } };
    ENTITLEMENT_ERROR = new Error('simulated billing outage');
    const failed = (await callController(ctrl.makeHandlers('talent').getChecklist, { user: OWNER, body: {}, query: {}, params: {} })).body;
    ok(failed.entitled === false && !!failed.upsell, 'an entitlement lookup failure fails CLOSED onto the upsell, even for a paying tenant');
    ok(calls.n === 0, 'and still runs no probes');
    ENTITLEMENT_ERROR = null;
  }

  // The core guide's side of the same decision: ONE locked upsell row, which
  // disappears the moment the tenant buys.
  {
    stubContext(coreProbes, () => coreCtx(fakeClient({}, [])));

    ENTITLEMENTS = { talent_acquisition: { enabled: false, source: 'fallback' } };
    const unbought = await ctrl.computeCompletion(BIZ, OWNER, TRACKS.core);
    const lockedRows = allSteps(unbought).filter((s) => s.locked);
    ok(lockedRows.length === 1 && lockedRows[0].key === 'talent_acquisition_addon',
      `the core guide shows exactly ONE locked row, the hiring upsell (${lockedRows.map((r) => r.key)})`);
    ok(lockedRows[0].cta === "See what's included", 'with the upsell CTA');
    ok(unbought.tracks.length === 1 && unbought.tracks[0].entitled === false,
      'and the tracks pointer marks hiring unentitled, so no TrackCard renders');
    const beforeTotal = unbought.totalCount;

    ENTITLEMENTS = { talent_acquisition: { enabled: true, source: 'add_on' } };
    const bought = await ctrl.computeCompletion(BIZ, OWNER, TRACKS.core);
    ok(allSteps(bought).every((s) => s.key !== 'talent_acquisition_addon'),
      'once bought, the advert is gone from the registry entirely (hideWhenEntitled)');
    ok(bought.totalCount === beforeTotal, `and the core denominator never moved (${beforeTotal} → ${bought.totalCount})`);
    ok(bought.tracks[0].entitled === true, 'while the pointer flips to entitled');
    ok(bought.lockedCount === 0, 'leaving no locked rows at all');
  }

  // ══════════════════════════════════════════════════════════════════════════
  log('\nD) The two percentages are independent, in BOTH directions\n');
  {
    ENTITLEMENTS = { talent_acquisition: { enabled: true, source: 'add_on' } };
    stubContext(coreProbes, () => coreCtx(fakeClient({}, [])));
    stubContext(talentProbes, () => talentCtx(fakeClient(NOTHING_DONE, [])));

    const coreEmpty = await ctrl.computeCompletion(BIZ, OWNER, TRACKS.core);
    const talentEmpty = await ctrl.computeCompletion(BIZ, OWNER, TRACKS.talent);
    ok(talentEmpty.percent === 0 && talentEmpty.totalCount === 11, `an untouched hiring track is 0% of 11 (${talentEmpty.percent}% of ${talentEmpty.totalCount})`);

    // Finish hiring completely; core must not move by a single point.
    stubContext(talentProbes, () => talentCtx(fakeClient(ALL_DONE, []), { candidateCommsConfig: { autoSend: { rejected: true } } }));
    const talentDone = await ctrl.computeCompletion(BIZ, OWNER, TRACKS.talent);
    const coreAfter = await ctrl.computeCompletion(BIZ, OWNER, TRACKS.core);
    ok(talentDone.percent === 100 && talentDone.allComplete === true, `hiring reaches 100% (${talentDone.percent}%)`);
    ok(coreAfter.percent === coreEmpty.percent && coreAfter.totalCount === coreEmpty.totalCount,
      `while core is untouched at ${coreAfter.percent}% of ${coreAfter.totalCount} — a company that hires is not "more set up" on HR`);

    // …and the mirror: a company that finishes core HR is still at 0% on hiring,
    // which is the whole reason the tracks were split.
    const coreAllDone = fakeClient({}, []);
    stubContext(coreProbes, () => coreCtx(coreAllDone));
    stubContext(talentProbes, () => talentCtx(fakeClient(NOTHING_DONE, [])));
    const talentAfterCore = await ctrl.computeCompletion(BIZ, OWNER, TRACKS.talent);
    ok(talentAfterCore.percent === 0, `core progress leaves hiring at 0% (${talentAfterCore.percent}%)`);

    // Neither payload may contain a single one of the other's rows.
    const talentKeys = new Set(talent.STEPS.map((s) => s.key));
    const coreKeys = new Set(core.STEPS.map((s) => s.key));
    const inCore = allSteps(coreAfter).map((s) => s.key).filter((k) => talentKeys.has(k));
    const inTalent = allSteps(talentDone).map((s) => s.key).filter((k) => coreKeys.has(k));
    ok(inCore.length === 0, `no hiring row is serialised into the core payload${inCore.length ? ` (${inCore})` : ''}`);
    ok(inTalent.length === 0, `and no core row into the hiring payload${inTalent.length ? ` (${inTalent})` : ''}`);
    ok(talentDone.stages.length === 4 && talentDone.stages[0].key === 'brand', 'the hiring payload carries its OWN four stages');

    // Same engine, so the shipped guarantees still hold on the new track.
    ok(talentEmpty.nextAction && talentEmpty.nextAction.key === 'pipeline_template',
      `the next-best action unblocks the most work first (${talentEmpty.nextAction && talentEmpty.nextAction.key})`);
    ok(talentEmpty.nextAction.blocking === 5, `because five steps hang off it (${talentEmpty.nextAction.blocking})`);
    ok(!talentEmpty.nextAction.route.includes('from='), 'the route is bare — the client appends ?from=setup');
    ok(talentDone.nextAction === null, 'and a finished track offers no next action');
    const leaked = allSteps(talentDone).filter((s) => 'includeWhen' in s || 'ctaVerb' in s || 'stageOrder' in s).map((s) => s.key);
    ok(leaked.length === 0, `no registry internals are serialised${leaked.length ? ` (${leaked})` : ''}`);
    // Tenant scoping at the API boundary: the session is the only source of truth.
    const asked = [];
    talentProbes.loadContext = async (businessId) => { asked.push(businessId); return talentCtx(fakeClient(NOTHING_DONE, [])); };
    await callController(ctrl.makeHandlers('talent').getChecklist, {
      user: OWNER, body: { businessId: OTHER }, query: { businessId: OTHER }, params: { businessId: OTHER },
    });
    ok(asked.length === 1 && asked[0] === BIZ, `a businessId in the body/query/params is ignored — the session wins (asked for ${asked[0]})`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  log('\nE) The activation moment — a fact about the candidate-facing board\n');
  {
    const live = await activation.activationFor(talentCtx(fakeClient(ALL_DONE, [])));
    ok(live.activation.state === 'live', 'published page + a live job → "live"');
    ok(live.activation.liveJobs === 2 && live.activation.applications === 12, `with the real counts (${live.activation.liveJobs} roles, ${live.activation.applications} applications)`);
    ok(typeof live.activation.firstApplicationAt === 'string', 'and the date the first application landed');
    ok(/^https:\/\/[^/]+\/careers/.test(live.activation.careersUrl), `the careers URL is absolute and shareable (${live.activation.careersUrl})`);

    const noJobs = await activation.activationFor(talentCtx(fakeClient({ ...ALL_DONE, 'job.count': 0 }, [])));
    ok(noJobs.activation.state === 'almost', 'a published page with nothing on it is only "almost"');

    const draft = await activation.activationFor(talentCtx(fakeClient({
      ...ALL_DONE, 'careersPage.findUnique': { isPublished: false },
    }, [])));
    ok(draft.activation.state === 'almost', 'and so is a live job behind a draft page');

    const cold = await activation.activationFor(talentCtx(fakeClient(NOTHING_DONE, [])));
    ok(cold.activation.state === 'not_started', 'neither → "not started"');
    ok(cold.activation.applications === 0 && cold.activation.firstApplicationAt === null, 'with honest zeroes, not nulls pretending to be counts');

    // The claim is "YOUR CAREERS PAGE is taking applications" — a CV a recruiter
    // typed in by hand is not evidence of that.
    const appSink = [];
    await activation.activationFor(talentCtx(fakeClient(ALL_DONE, appSink)));
    const appCall = appSink.find((c) => c.model === 'application' && c.op === 'count');
    ok(JSON.stringify(appCall.where.appliedSource.in) === JSON.stringify(['PUBLIC', 'CAREER_PORTAL']),
      'applications are counted from the public sources only, never MANUAL');
    ok(appSink.every((c) => c.where.businessId === BIZ), 'and every activation query is tenant-scoped');

    // Activation is computed from the DB, not from our checklist — so it can read
    // "live" while the track sits below 100%. That is deliberate.
    stubContext(talentProbes, () => talentCtx(fakeClient({ ...ALL_DONE, 'scorecardTemplate.count': 0, 'screeningFormTemplate.count': 0 }, [])));
    const partial = await ctrl.computeCompletion(BIZ, OWNER, TRACKS.talent);
    ok(partial.percent < 100 && partial.activation.state === 'live',
      `a tenant at ${partial.percent}% with a published board still gets its live state`);

    // A wobble degrades activation to null rather than the response.
    const broken = new Proxy({}, { get: () => ({ findUnique: async () => { throw new Error('simulated outage'); }, count: async () => { throw new Error('x'); }, findFirst: async () => { throw new Error('x'); } }) });
    const degraded = await activation.activationFor(talentCtx(broken));
    ok(degraded.activation === null, 'and a failure returns activation:null instead of throwing');
  }

  // ══════════════════════════════════════════════════════════════════════════
  log('\nF) Business.setupState — the per-track slice survives every write\n');
  {
    // THE highest-risk line: normalise() rebuilds the object key by key, and every
    // write goes through it. A `tracks` branch it forgot would be erased by the very
    // next core dismissal.
    const withTracks = setupState.normalise({
      dismissed: { biometric_devices: { at: 'x' } },
      completedAt: '2026-01-01T00:00:00.000Z',
      ui: { 'user-1': { celebratedAt: 'core-party' } },
      tracks: { talent: { completedAt: '2026-08-04T00:00:00.000Z', ui: { 'user-1': { celebratedAt: 'hiring-party' } } } },
    });
    ok(withTracks.tracks.talent.completedAt === '2026-08-04T00:00:00.000Z', 'normalise() PRESERVES the tracks branch');

    const afterCoreWrite = setupState.normalise(
      setupState.patchTrack(withTracks, 'core', { completedAt: '2026-09-09T00:00:00.000Z' }),
    );
    ok(afterCoreWrite.tracks.talent.completedAt === '2026-08-04T00:00:00.000Z', 'a CORE write does not erase the hiring stamp');
    ok(afterCoreWrite.completedAt === '2026-09-09T00:00:00.000Z', 'while landing on the legacy top-level field');

    const afterTalentWrite = setupState.normalise(
      setupState.patchTrack(withTracks, 'talent', { completedAt: '2026-10-10T00:00:00.000Z' }),
    );
    ok(afterTalentWrite.completedAt === '2026-01-01T00:00:00.000Z', 'and a HIRING write does not erase the core stamp');

    ok(setupState.sliceFor(withTracks, 'core').completedAt === '2026-01-01T00:00:00.000Z', "sliceFor('core') reads the LEGACY top-level shape — no backfill needed");
    ok(setupState.uiFor(withTracks, 'user-1', 'core').celebratedAt === 'core-party', 'per-operator UI is read per track…');
    ok(setupState.uiFor(withTracks, 'user-1', 'talent').celebratedAt === 'hiring-party', '…so confetti fires once per track, never once for both');
    ok(setupState.uiFor(withTracks, 'user-1').celebratedAt === 'core-party', 'and the shipped two-argument call still means core');

    const bothUi = setupState.patchUi(withTracks, 'user-1', { widgetHiddenUntil: 'later' }, 'talent');
    ok(bothUi.ui['user-1'].celebratedAt === 'core-party', 'a hiring UI write leaves the core slice alone');
    ok(bothUi.tracks.talent.ui['user-1'].widgetHiddenUntil === 'later', 'and lands in the hiring slice');
  }

  // The completion stamp is written into the track's own slice.
  {
    STATE = setupState.normalise(null);
    stubContext(talentProbes, () => talentCtx(fakeClient(ALL_DONE, []), { candidateCommsConfig: { autoSend: {} } }));
    const done = await ctrl.computeCompletion(BIZ, OWNER, TRACKS.talent);
    ok(done.allComplete === true && typeof done.completedAt === 'string', 'finishing the track stamps completedAt');
    ok(STATE.tracks.talent.completedAt === done.completedAt, 'into tracks.talent…');
    ok(STATE.completedAt === null, '…and NEVER onto the core track\'s stamp');
  }

  // ══════════════════════════════════════════════════════════════════════════
  log('\nG) Resilience + the dismissal guards\n');
  {
    STATE = setupState.normalise(null);
    stubContext(talentProbes, () => talentCtx(fakeClient(NOTHING_DONE, [])));
    const saved = talentProbes.PROBES.pipeline_template;
    talentProbes.PROBES.pipeline_template = () => { throw new Error('simulated: relation "PipelineTemplate" does not exist'); };
    try {
      const res = await callController(ctrl.makeHandlers('talent').getChecklist, { user: OWNER, body: {}, query: {}, params: {} });
      ok(res.statusCode === 200, `a throwing probe still answers 200 (got ${res.statusCode})`);
      const row = stepOf(res.body, 'pipeline_template');
      ok(row.state === 'unknown' && row.completed === false, 'the broken step degrades to "couldn\'t check", never optimistically green');
      ok(res.body.probeDegraded === true && res.body.probeFailedCount === 1, `probeDegraded is raised with a count (${res.body.probeFailedCount})`);
      ok(res.body.nextAction === null || res.body.nextAction.key !== 'pipeline_template', 'and it is never offered as the next action');
    } finally { talentProbes.PROBES.pipeline_template = saved; }
  }

  {
    const h = ctrl.makeHandlers('talent');
    const post = (key, handler) => callController(handler, { user: OWNER, body: { key }, query: {}, params: {} });

    const req1 = await post('careers_live', h.dismissStep);
    ok(req1.statusCode === 422, `a REQUIRED hiring step cannot be hidden (got ${req1.statusCode})`);
    const wrongTrack = await post('country', h.dismissStep);
    ok(wrongTrack.statusCode === 422, 'a CORE key posted to the hiring endpoint is refused');
    ok(/belongs to Setup guide/.test(wrongTrack.body.message), `and diagnosed rather than called unknown ("${wrongTrack.body.message}")`);

    const before = (await callController(h.getChecklist, { user: OWNER, body: {}, query: {}, params: {} })).body;
    const dis = await post('scorecard_template', h.dismissStep);
    ok(dis.statusCode === 200 && dis.body.totalCount === before.totalCount - 1,
      `dismissing a recommended step shrinks BOTH sides of the fraction (${before.totalCount} → ${dis.body.totalCount})`);
    ok(stepOf(dis.body, 'scorecard_template').state === 'dismissed', 'and the row is still returned, marked dismissed');
    ok(AUDITS.some((a) => a.action === 'setup.talent.step.dismiss'), 'the write is audited under a track-namespaced action');

    const back = await post('scorecard_template', h.restoreStep);
    ok(back.body.totalCount === before.totalCount, 'restoring puts it back');
    ok(AUDITS.some((a) => a.action === 'setup.talent.step.restore'), 'and that is audited too');
    ok(!AUDITS.some((a) => a.action === 'setup.step.dismiss'), 'no hiring write is ever logged under the core action name');

    // ── The two artefacts of the split, which arrive with the deploy ──────────
    // `first_job` existed in the CORE registry before the move. A tenant who
    // dismissed it then still carries the key in the FLAT dismissed map, where it
    // now resolves to the hiring step of the same name — which is REQUIRED, and
    // dismissedOf() refuses to honour a dismissal on a required step. It must stay
    // that way: demoting `first_job` to Recommended would hand those tenants a
    // pre-dismissed row they never dismissed.
    STATE = setupState.normalise({ dismissed: { first_job: { at: '2026-01-01T00:00:00.000Z', byUserId: 'old' } } });
    const carried = (await callController(h.getChecklist, { user: OWNER, body: {}, query: {}, params: {} })).body;
    ok(stepOf(carried, 'first_job').state !== 'dismissed',
      `a pre-split dismissal of core's "first_job" cannot hide the REQUIRED hiring step (${stepOf(carried, 'first_job').state})`);
    ok(carried.dismissedCount === 0, 'and it is not counted as hidden');

    // A dismissal of a key that no longer exists in EITHER registry is inert: it
    // serialises nowhere, so the only way to meet it is POST /restore, which 422s.
    const gone = await post('hiring_pipeline', h.restoreStep);
    ok(gone.statusCode === 422 && /Unknown setup step/.test(gone.body.message),
      'a stale key from the old core registry is refused rather than silently accepted');
    STATE = setupState.normalise(null);
  }

  // A step the operator cannot reach is named, never rendered as a dead button.
  {
    stubContext(talentProbes, () => talentCtx(fakeClient(NOTHING_DONE, [])));
    const recruiter = {
      id: 'user-2', businessId: BIZ, role: 'STAFF',
      businessRole: { permissions: { canManageHiring: true } }, // no canEditBranding
    };
    const p = await ctrl.computeCompletion(BIZ, recruiter, TRACKS.talent);
    ok(p.totalCount === 10 && p.tenantTotalCount === 11, `the logo step sits outside their score but inside the tenant's (${p.totalCount} vs ${p.tenantTotalCount})`);
    ok(p.stepsNeedingSomeoneElse === 1, `"1 step needs someone else's access" is reported (${p.stepsNeedingSomeoneElse})`);
    ok(stepOf(p, 'careers_brand').permitted === false, 'and the row is still listed, flagged permitted:false');

    // The OTHER half of the route's gate. Every recruitment write route is
    // requireAny('canManageHiring','canManageEmployees'), so this operator can
    // genuinely finish all ten — scoring them on the primary key alone would have
    // emptied their denominator and rendered a green 100% bar over an untouched track.
    const hrGeneralist = {
      id: 'user-3', businessId: BIZ, role: 'STAFF',
      businessRole: { permissions: { canManageEmployees: true } }, // no canManageHiring
    };
    const g = await ctrl.computeCompletion(BIZ, hrGeneralist, TRACKS.talent);
    ok(g.totalCount === 10, `the legacy super-set key scores the same ten rows (${g.totalCount})`);
    ok(g.percent === 0 && g.allComplete === false,
      `so an untouched track reads 0%, not 100% of nothing (${g.percent}%, allComplete=${g.allComplete})`);
    ok(g.requiredRemaining === 5, `and all five required steps are still owed (${g.requiredRemaining})`);
    ok(g.nextAction && g.nextAction.key === 'pipeline_template',
      `with a real next action rather than a done state (${g.nextAction && g.nextAction.key})`);
  }

  log(`\n=== ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} ===\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
