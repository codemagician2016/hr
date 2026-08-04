'use strict';

/*
 * checklistItems.test.js — registry integrity. Pure unit; no DB, no DATABASE_URL.
 *
 * The registry is the single source of truth for the whole Setup Guide, so a typo
 * in it is a silent product bug: a step with no probe scores as "couldn't check"
 * forever, a dependsOn typo strands every dependant, and a permission key that is
 * not in the RBAC catalog hides the step from EVERY operator (nothing grants a key
 * that does not exist). This file is the cheap guard against all of that.
 *
 *   node src/hr/setup/__tests__/checklistItems.test.js
 */

const { STAGES, STAGE_ORDER, STEPS, BY_KEY, BLOCKING, ancestorsOf } = require('../checklistItems');
const { PROBES } = require('../probes');
const { PERMISSIONS } = require('../../../core/lib/rbac');
const { HR_ADDON_KEYS } = require('../../../core/lib/entitlements');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

log('\n=== Setup checklist — registry integrity ===\n');

// ── Stages ────────────────────────────────────────────────────────────────────
ok(STAGES.length === 5, `five stages declared (${STAGES.length})`);
ok(STAGES.every((s, i) => s.order === i + 1), 'stage order is 1..5 with no gaps');
ok(new Set(STAGES.map((s) => s.key)).size === STAGES.length, 'stage keys are unique');

// ── Keys, stages, order ───────────────────────────────────────────────────────
{
  const keys = STEPS.map((s) => s.key);
  ok(new Set(keys).size === keys.length, `step keys are unique (${keys.length} steps)`);
  ok(STEPS.every((s, i) => s.order === i + 1), 'global `order` is the declared index, 1-based, no gaps');
  const badStage = STEPS.filter((s) => !STAGE_ORDER[s.stage]);
  ok(badStage.length === 0, `every step names a real stage${badStage.length ? ` (bad: ${badStage.map((s) => s.key)})` : ''}`);
  ok(STEPS.every((s) => s.stageOrder === STAGE_ORDER[s.stage]), 'stageOrder is derived from the stage, never hand-typed');
}

// ── Every step has a probe, and every probe has a step ─────────────────────────
// EXCEPT an upsell-only row (`hideWhenEntitled`), which is an advert rather than a
// task: it is locked while the tenant lacks the add-on and removed from the
// registry outright once they hold it, so it is never probed either way.
{
  const probeable = STEPS.filter((s) => !s.hideWhenEntitled);
  const noProbe = probeable.filter((s) => !PROBES[s.key]).map((s) => s.key);
  ok(noProbe.length === 0, `every probeable step has a probe${noProbe.length ? ` (missing: ${noProbe})` : ''}`);
  const orphans = Object.keys(PROBES).filter((k) => !BY_KEY.has(k));
  ok(orphans.length === 0, `no orphan probes${orphans.length ? ` (${orphans})` : ''}`);
  // The four recruitment probes moved to the talent track with their rows. A copy
  // left behind here would be exactly the drift this split exists to prevent.
  const moved = ['hiring_pipeline', 'careers_page', 'candidate_messages', 'careers_live'].filter((k) => PROBES[k]);
  ok(moved.length === 0, `no recruitment probe survives in the core map${moved.length ? ` (${moved})` : ''}`);
}

// ── RBAC keys must exist, or the step is invisible to everyone ────────────────
{
  const unknown = STEPS.filter((s) => !(s.permission in PERMISSIONS)).map((s) => `${s.key}:${s.permission}`);
  ok(unknown.length === 0, `every permission is in the RBAC catalog${unknown.length ? ` (bad: ${unknown})` : ''}`);
  // Guards against copying fbp.routes.js's `canManagePayroll`, which is NOT a real
  // key — even the Owner preset lacks it, so it locks everyone out.
  ok(!STEPS.some((s) => s.permission === 'canManagePayroll'), 'no step uses the phantom canManagePayroll key');
}

// ── Entitlements must be real add-on keys ─────────────────────────────────────
// Hiring moved to its OWN track, so the core guide keeps exactly ONE add-on row —
// the locked upsell that points at it. LockedRow takes its single-row branch and
// renders inline rather than behind a "Not on your plan (4)" disclosure.
{
  const gated = STEPS.filter((s) => s.entitlement);
  const bad = gated.filter((s) => !HR_ADDON_KEYS.includes(s.entitlement)).map((s) => s.key);
  ok(gated.length === 1 && gated[0].key === 'talent_acquisition_addon', `exactly one add-on row, and it is the upsell (${gated.map((s) => s.key)})`);
  ok(bad.length === 0, `every entitlement is a real HR add-on key${bad.length ? ` (bad: ${bad})` : ''}`);
  // The nav's feature: strings are NOT entitlement keys and are absent from the catalog.
  ok(!gated.some((s) => ['hr', 'payroll', 'leave', 'attendance'].includes(s.entitlement)), 'no nav `feature:` string is used as an entitlement key');
  // hideWhenEntitled without an entitlement key is a no-op row that would never
  // disappear — the filter reads `entitlements[s.entitlement]`.
  const orphanHide = STEPS.filter((s) => s.hideWhenEntitled && !s.entitlement).map((s) => s.key);
  ok(orphanHide.length === 0, `every hideWhenEntitled row names its add-on${orphanHide.length ? ` (${orphanHide})` : ''}`);
  // Owner decision 1, asserted structurally: no recruitment step is left in core.
  const recruitment = ['hiring_pipeline', 'careers_page', 'candidate_messages', 'first_job',
    'careers_content', 'pipeline_template', 'job_public'].filter((k) => BY_KEY.has(k));
  ok(recruitment.length === 0, `no hiring step sits in the core registry${recruitment.length ? ` (${recruitment})` : ''}`);
}

// ── Dependencies form a DAG that resolves ─────────────────────────────────────
{
  const dangling = [];
  for (const s of STEPS) for (const d of s.dependsOn) if (!BY_KEY.has(d)) dangling.push(`${s.key}->${d}`);
  ok(dangling.length === 0, `every dependsOn resolves${dangling.length ? ` (dangling: ${dangling})` : ''}`);

  const selfDep = STEPS.filter((s) => ancestorsOf(s.key).has(s.key)).map((s) => s.key);
  ok(selfDep.length === 0, `no dependency cycles${selfDep.length ? ` (in: ${selfDep})` : ''}`);

  // A dependency must come EARLIER in the declared order, otherwise the accordion
  // shows a prerequisite below the step that waits on it.
  const backwards = [];
  for (const s of STEPS) for (const d of s.dependsOn) if (BY_KEY.get(d).order > s.order) backwards.push(`${s.key}<-${d}`);
  ok(backwards.length === 0, `dependencies are always declared earlier${backwards.length ? ` (${backwards})` : ''}`);
}

// ── blocking is the transitive dependant count, computed once ─────────────────
{
  ok(BLOCKING.country === 57, `country blocks the most work (${BLOCKING.country} steps)`);
  ok(BLOCKING.entity > BLOCKING.employees, 'entity outranks employees (it is upstream of it)');
  ok(STEPS.every((s) => s.blocking === BLOCKING[s.key]), 'each step carries its own blocking count');
  // Leaves block nothing — a good sanity check that the closure is not counting self.
  ok(BLOCKING.first_course === 0, 'a leaf step blocks nothing');
}

// ── Required / dismissible invariants ─────────────────────────────────────────
{
  const required = STEPS.filter((s) => s.required);
  ok(required.length === 17, `17 required steps declared (${required.length})`);
  ok(!required.some((s) => s.dismissible), 'a required step is NEVER dismissible');
  ok(STEPS.filter((s) => !s.required).every((s) => s.dismissible), 'every recommended step is dismissible');
  ok(!required.some((s) => s.entitlement), 'no required step is behind a paid add-on (100% must be reachable on any plan)');
  ok(!required.some((s) => s.includeWhen), 'no required step is conditional');
  // A required step must never wait on one that can VANISH from the tenant's list —
  // a locked (add-on) or conditional prerequisite can never turn green, which would
  // strand a step the tenant has no choice about. Depending on a merely Recommended
  // step is fine: it is still probed, and computeCompletion's prerequisite rule only
  // blocks on a dep it positively knows is unfinished.
  const fragile = required
    .filter((s) => s.dependsOn.some((d) => BY_KEY.get(d).entitlement || BY_KEY.get(d).includeWhen))
    .map((s) => s.key);
  ok(fragile.length === 0, `no required step waits on a lockable/conditional one${fragile.length ? ` (${fragile})` : ''}`);
  // The single soft edge in the registry, asserted so it stays deliberate: holidays
  // is Required but hangs off locations, which is Recommended AND dismissible. It
  // renders with a prerequisite hint rather than blocking, and a tenant that never
  // adds a site still gets its holiday list.
  const softEdges = required
    .filter((s) => s.dependsOn.some((d) => !BY_KEY.get(d).required))
    .map((s) => `${s.key}<-${s.dependsOn.filter((d) => !BY_KEY.get(d).required).join(',')}`);
  ok(softEdges.length === 1 && softEdges[0] === 'holidays<-locations', `exactly one required→recommended edge, and it is the known one (${softEdges})`);
}

// ── Country split ─────────────────────────────────────────────────────────────
{
  const inOnly = STEPS.filter((s) => s.countryOnly === 'IN');
  ok(inOnly.length === 8, `8 India-only steps (${inOnly.length})`);
  ok(STEPS.every((s) => !s.countryOnly || ['IN', 'NZ'].includes(s.countryOnly)), 'countryOnly is IN or NZ only');
  const nzTotal = STEPS.length - inOnly.length;
  ok(STEPS.length === 67 && nzTotal === 59, `67 steps for India, 59 for New Zealand (${STEPS.length}/${nzTotal})`);
  // An India-only step must not depend on a step the NZ tenant would keep — that is
  // fine — but it MUST NOT be depended upon by a country-agnostic step.
  const leak = STEPS.filter((s) => !s.countryOnly && s.dependsOn.some((d) => BY_KEY.get(d).countryOnly)).map((s) => s.key);
  ok(leak.length === 0, `no country-agnostic step depends on a country-only one${leak.length ? ` (${leak})` : ''}`);
}

// ── Copy contract (this is a plain-English guide; the words are the product) ───
{
  const missing = STEPS.filter((s) => !s.label || !s.description || !s.why
    || !s.explain || !s.explain.plain || !s.explain.example || !s.explain.ifYouSkip).map((s) => s.key);
  ok(missing.length === 0, `every step carries label/description/why/explain${missing.length ? ` (thin: ${missing})` : ''}`);

  const longCta = STEPS.filter((s) => !s.cta || s.cta.split(/\s+/).length > 4).map((s) => `${s.key}:"${s.cta}"`);
  ok(longCta.length === 0, `every CTA is verb+object, 4 words or fewer${longCta.length ? ` (${longCta})` : ''}`);

  const badWho = STEPS.filter((s) => !['HR', 'Finance', 'the Owner', 'your IT person'].includes(s.doneBy)).map((s) => s.key);
  ok(badWho.length === 0, `doneBy is one of the four known personas${badWho.length ? ` (${badWho})` : ''}`);

  // An upsell-only row has no time estimate because there is no work to do — it is
  // a thing to buy, not a thing to finish.
  const badMins = STEPS.filter((s) => !s.hideWhenEntitled && (!Number.isFinite(s.minutes) || s.minutes < 1)).map((s) => s.key);
  ok(badMins.length === 0, `every actionable step has a plausible minutes estimate${badMins.length ? ` (${badMins})` : ''}`);
  ok(STEPS.filter((s) => s.hideWhenEntitled).every((s) => s.minutes === null), 'an upsell-only row carries no time estimate');

  const noRoute = STEPS.filter((s) => !s.route || !s.route.startsWith('/')).map((s) => s.key);
  ok(noRoute.length === 0, `every step deep-links to a real screen path${noRoute.length ? ` (${noRoute})` : ''}`);
  // The client appends ?from=setup / &from=setup itself — a pre-baked one would
  // double up.
  ok(!STEPS.some((s) => s.route.includes('from=setup')), 'routes are BARE (the client appends ?from=)');
}

// ── The registry is frozen: a controller bug cannot poison later requests ──────
{
  const before = STEPS[0].label;
  try { STEPS[0].label = 'mutated'; } catch (_e) { /* strict-mode throw is also a pass */ }
  ok(STEPS[0].label === before, 'steps are frozen — a request handler cannot mutate the registry');
}

log(`\n=== ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} ===\n`);
if (failures > 0) process.exit(1);
