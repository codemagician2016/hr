'use strict';

/**
 * setupChecklist.controller.js — the Setup Guide API (GET /api/hr/setup-checklist).
 *
 * Same shape as sitepresso's launch.controller.js: a DECLARATIVE registry
 * (setup/checklistItems.js) plus one computeCompletion() that probes real tenant
 * data (setup/probes.js). Everything else here is filtering and arithmetic.
 *
 * TENANT SCOPING: businessId always comes from req.user.businessId. The controller
 * never reads a businessId from the body, the query or a param.
 *
 * GATING IS ADVISORY. Nothing in DriftHR reads this endpoint to block an action; it
 * exists to show a percentage, one next step, and a done state. Consequently the
 * response is allowed to be imperfect but must never be DISHONEST:
 *   • a step whose probe threw reports state 'unknown' — it counts in the
 *     denominator, never in the numerator, and is never offered as the next action;
 *   • if EVERY probe fails we return percent: null rather than inventing 0 or 100;
 *   • rounding is clamped so 99.6% never renders as "you're all set".
 *
 * THREE FILTERS remove a step from the operator's score, each for a different reason:
 *   country/conditional  never serialised at all (an NZ tenant does not see India
 *                        rows greyed out — they do not exist)
 *   locked / dismissed   serialised, excluded from BOTH sides of the fraction, so
 *                        100% stays reachable on any plan and after any "not for us"
 *   not permitted        serialised with permitted:false, excluded from the
 *                        operator's fraction but kept inside tenantPercent
 */

const { writeAudit } = require('../../core/lib/audit');
const { hrEntitlements } = require('../../core/lib/entitlements');
const { effectivePermissions } = require('../../core/lib/rbac');
const { ROLES } = require('../../core/lib/roles');
const { STAGES, STEPS, BY_KEY } = require('../setup/checklistItems');
const { loadContext, runProbes } = require('../setup/probes');
const { pickNextAction } = require('../setup/nextAction');
const setupState = require('../setup/setupState');

// Sellable add-ons a step can be gated behind → the words the upsell row uses.
// `talent_acquisition` is the only HR add-on key that exists (HR_ADDON_KEYS); the
// nav's `feature:` strings ('hr','payroll','leave','attendance') are NOT entitlement
// keys and must never be passed to booleanEntitlement.
const ADDON_LABELS = Object.freeze({ talent_acquisition: 'Talent Acquisition' });

// The exact field set that reaches the client. Built by hand rather than spread so
// the registry's internals (the includeWhen predicate, the next-action CTA verb,
// the numeric stage order) can never leak by accident.
const PUBLIC_STEP_FIELDS = Object.freeze([
  'key', 'label', 'description', 'why', 'explain', 'stage', 'order', 'required',
  'route', 'cta', 'completed', 'state', 'probe', 'locked', 'lockedReason',
  'permission', 'permitted', 'countryOnly', 'prismaModel', 'dependsOn',
  'prerequisitesMet', 'blocking', 'dismissible', 'minutes', 'doneBy', 'coverage',
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function publicStep(row) {
  const out = {};
  for (const f of PUBLIC_STEP_FIELDS) out[f] = row[f] === undefined ? null : row[f];
  return out;
}

// Resolve the operator's permission map. SUPER_ADMIN bypasses RBAC everywhere else
// in the product (requirePermission short-circuits on it), so it must here too —
// otherwise a support login would see a permission-starved 0-step checklist.
function permissionsFor(user) {
  if (user && user.role === ROLES.SUPER_ADMIN) return null; // null = everything permitted
  return effectivePermissions(user) || {};
}

// Rounded percent with the two clamps the spec fixes: rounding may never claim
// 100% while work remains, and any real progress is worth at least 1%.
function scorePercent(completed, total) {
  if (total === 0) return 100;
  let pct = Math.round((completed / total) * 100);
  if (completed < total && pct >= 100) pct = 99;
  if (completed > 0 && pct < 1) pct = 1;
  return pct;
}

/**
 * computeCompletion — the whole payload, minus the HTTP wrapper.
 *
 * Exported so the companion POSTs can return a freshly-recomputed body without
 * re-entering the router, and so the tests can call it directly.
 */
async function computeCompletion(businessId, user) {
  const perms = permissionsFor(user);
  const userId = (user && user.id) || null;
  const permitted = (key) => (perms === null ? true : !!perms[key]);

  const [ctx, entitlements, state] = await Promise.all([
    loadContext(businessId),
    // Fail CLOSED on a billing-lookup wobble: a locked row is excluded from both
    // sides of the fraction, so a transient wrong upsell cannot dent the score,
    // whereas failing open would drop four uncompletable rows into a free
    // tenant's denominator and cap them below 100% forever.
    hrEntitlements(businessId).catch((e) => {
      console.warn(`setup-checklist: entitlement lookup failed for business ${businessId} — ${e.message}`);
      return {};
    }),
    setupState.readSetupState(businessId),
  ]);
  if (!ctx) return null;

  // ── Pass 1: which steps exist for this tenant at all, and in what state ──────
  const included = STEPS.filter((s) => {
    // Country resolution FAILS OPEN: while hrCountry is still null (a brand-new
    // tenant, before the country lock) the India-only rows are emitted, mirroring
    // nav.hasCountry, so an IN tenant sees no load-time flash.
    if (s.countryOnly && ctx.country && s.countryOnly !== ctx.country) return false;
    if (s.includeWhen && !s.includeWhen(ctx)) return false;
    return true;
  });

  const lockedOf = (s) => !!s.entitlement
    && !(entitlements[s.entitlement] && entitlements[s.entitlement].enabled === true);
  // A required step can never be dismissed. The POST rejects it, but a stale key
  // in the JSON (or a step later promoted to Required) must not slip through here.
  const dismissedOf = (s) => !s.required && !!state.dismissed[s.key];

  const probeKeys = included.filter((s) => !lockedOf(s) && !dismissedOf(s)).map((s) => s.key);
  const status = await runProbes(ctx, probeKeys);

  const rows = included.map((s) => {
    const locked = lockedOf(s);
    const dismissed = !locked && dismissedOf(s);
    const probeResult = status[s.key];

    let stepState;
    if (locked) stepState = 'locked';
    else if (dismissed) stepState = 'dismissed';
    else if (!probeResult || probeResult.ok !== true) stepState = 'unknown';
    else stepState = probeResult.completed ? 'done' : 'todo';

    return {
      key: s.key,
      label: s.label,
      description: s.description,
      why: s.why,
      explain: s.explain,
      stage: s.stage,
      stageOrder: s.stageOrder,
      order: s.order,
      required: s.required,
      route: s.route,
      ctaVerb: s.cta, // internal — the next-action card's verb+object button
      cta: locked ? "See what's included" : (stepState === 'done' ? 'Review' : 'Set up'),
      completed: stepState === 'done',
      state: stepState,
      probe: stepState === 'unknown' ? 'unknown' : 'ok',
      locked,
      lockedReason: locked ? {
        addOn: s.entitlement,
        planLabel: ADDON_LABELS[s.entitlement] || s.entitlement,
        message: `Included in ${ADDON_LABELS[s.entitlement] || s.entitlement}.`,
        route: `/settings?tab=billing&highlight=${s.entitlement}`,
      } : null,
      permission: s.permission,
      permitted: permitted(s.permission),
      countryOnly: s.countryOnly || null,
      prismaModel: s.prismaModel,
      dependsOn: s.dependsOn,
      blocking: s.blocking,
      dismissible: s.dismissible,
      minutes: s.minutes,
      doneBy: s.doneBy,
      coverage: (probeResult && probeResult.coverage) || null,
    };
  });

  // ── Pass 2: prerequisites ───────────────────────────────────────────────────
  // A dependency blocks only when we POSITIVELY know it is unfinished. A dep that
  // is absent for this tenant (country/conditional), locked, dismissed, or whose
  // own probe failed can never turn green, so treating it as blocking would strand
  // its dependants forever.
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const row of rows) {
    row.prerequisitesMet = row.dependsOn.every((dep) => {
      const d = byKey.get(dep);
      return !d || d.state !== 'todo';
    });
  }

  // ── Pass 3: the two scored sets ─────────────────────────────────────────────
  const scorable = rows.filter((r) => !r.locked && r.state !== 'dismissed');
  const mine = scorable.filter((r) => r.permitted);

  const tally = (set) => {
    const completed = set.filter((r) => r.state === 'done').length;
    const total = set.length;
    const allUnknown = total > 0 && set.every((r) => r.state === 'unknown');
    return {
      completedCount: completed,
      totalCount: total,
      // Never fabricate 0% and never fabricate 100% — the client renders "—".
      percent: allUnknown ? null : scorePercent(completed, total),
      requiredRemaining: set.filter((r) => r.required && r.state !== 'done').length,
    };
  };

  const own = tally(mine);
  const tenant = tally(scorable);

  const allComplete = own.percent === 100 && own.requiredRemaining === 0;
  const tenantAllComplete = tenant.percent === 100 && tenant.requiredRemaining === 0;

  // ── The one-time tenant completion stamp ────────────────────────────────────
  // Driven by the TENANT score, not the operator's, so the moment is stamped once
  // for the business rather than once per person who happens to hold every key.
  let completedAt = state.completedAt;
  if (tenantAllComplete && !completedAt) {
    completedAt = new Date().toISOString();
    try {
      await setupState.mergeSetupState(businessId, (s) => ({ ...s, completedAt }));
    } catch (e) {
      console.warn(`setup-checklist: could not stamp completedAt for business ${businessId} — ${e.message}`);
    }
  }

  // ── Next action ─────────────────────────────────────────────────────────────
  // Ranked over EVERY scorable row (not just the permitted ones) so a step this
  // operator cannot reach can still be named as the blocker.
  const scopedKeys = mine.map((r) => r.key);
  const { nextAction, nextActionBlocked } = pickNextAction(scorable, scopedKeys);

  // ── Stages ──────────────────────────────────────────────────────────────────
  const stages = STAGES.map((stage) => {
    const stageRows = rows.filter((r) => r.stage === stage.key);
    const stageScored = stageRows.filter((r) => !r.locked && r.state !== 'dismissed' && r.permitted);
    const done = stageScored.filter((r) => r.state === 'done').length;
    const requiredRemaining = stageScored.filter((r) => r.required && r.state !== 'done').length;
    let stageStatus;
    if (stageScored.length === 0 || done === stageScored.length) stageStatus = 'done';
    else if (done === 0) stageStatus = 'not_started';
    else if (requiredRemaining === 0) stageStatus = 'required_done';
    else stageStatus = 'in_progress';
    return {
      key: stage.key,
      title: stage.title,
      subtitle: stage.subtitle,
      order: stage.order,
      completedCount: done,
      totalCount: stageScored.length,
      requiredRemaining,
      status: stageStatus,
      steps: stageRows.map(publicStep),
    };
  });

  const ui = setupState.uiFor(state, userId);
  // "Completing any step resets nudgeDismissals to 0" — the streak is counted
  // against the completedCount it was recorded at, so finishing anything clears it
  // without a write. The lifetime nudgeShownCount cap deliberately never resets.
  const nudgeDismissals = (ui.nudgeCompletedCount === own.completedCount) ? ui.nudgeDismissals : 0;

  return {
    country: ctx.country,
    currency: ctx.currency,
    generatedAt: new Date().toISOString(),

    // Operator-scoped score — THIS is the number every surface renders.
    percent: own.percent,
    completedCount: own.completedCount,
    totalCount: own.totalCount,
    requiredRemaining: own.requiredRemaining,
    allRequiredComplete: own.requiredRemaining === 0,
    allComplete,

    // Tenant-wide score, for the "waiting on someone else" line only.
    tenantPercent: tenant.percent,
    tenantCompletedCount: tenant.completedCount,
    tenantTotalCount: tenant.totalCount,
    tenantAllComplete,
    stepsNeedingSomeoneElse: tenant.totalCount - own.totalCount,

    // Celebration bookkeeping.
    completedAt,
    celebratedAt: ui.celebratedAt,

    // Honesty flags.
    lockedCount: rows.filter((r) => r.locked).length,
    dismissedCount: rows.filter((r) => r.state === 'dismissed').length,
    // Scoped to the OPERATOR's set, because these two qualify `percent` — the header
    // renders "you're at LEAST 41% set up", so a failed probe on a step outside
    // their score must not make their own number look uncertain.
    probeDegraded: mine.some((r) => r.state === 'unknown'),
    probeFailedCount: mine.filter((r) => r.state === 'unknown').length,

    nextAction,
    nextActionBlocked,
    stages,

    // Per-operator UI bookkeeping + tenant age. Additive to the locked contract,
    // and required by it: the dashboard widget's "hide for 7 days" and the nudge's
    // show/dismiss caps (<5 shown, <3 dismissals, tenant <90 days old) are all
    // stated as trigger conditions with no other way for the client to read them.
    ui: {
      widgetHiddenUntil: ui.widgetHiddenUntil,
      nudgeDismissals,
      nudgeShownCount: ui.nudgeShownCount,
      nudgeLastShownAt: ui.nudgeLastShownAt,
      celebratedAt: ui.celebratedAt,
    },
    tenantAgeDays: ctx.business.createdAt
      ? Math.max(0, Math.floor((Date.now() - new Date(ctx.business.createdAt).getTime()) / DAY_MS))
      : null,
  };
}

// GET /api/hr/setup-checklist
async function getChecklist(req, res, next) {
  try {
    const { businessId } = req.user;
    if (!businessId) return res.status(400).json({ message: 'No business on this session' });
    const payload = await computeCompletion(businessId, req.user);
    if (!payload) return res.status(404).json({ message: 'Business not found' });
    res.json(payload);
  } catch (e) { next(e); }
}

// POST /api/hr/setup-checklist/dismiss  { key } — "not needed for us".
async function dismissStep(req, res, next) {
  try {
    const { businessId } = req.user;
    const key = String((req.body && req.body.key) || '');
    const step = BY_KEY.get(key);
    if (!step) return res.status(422).json({ message: `Unknown setup step: ${key}` });
    if (step.required) {
      return res.status(422).json({ message: `"${step.label}" is required and cannot be hidden.` });
    }

    await setupState.mergeSetupState(businessId, (s) => ({
      ...s,
      dismissed: { ...s.dismissed, [key]: { at: new Date().toISOString(), byUserId: req.user.id || null } },
    }));
    await writeAudit({
      businessId, actorId: req.user.id,
      action: 'setup.step.dismiss', entityType: 'Business', entityId: businessId,
      meta: { key, label: step.label },
    });

    res.json(await computeCompletion(businessId, req.user));
  } catch (e) { next(e); }
}

// POST /api/hr/setup-checklist/restore  { key } — undo a dismissal.
async function restoreStep(req, res, next) {
  try {
    const { businessId } = req.user;
    const key = String((req.body && req.body.key) || '');
    const step = BY_KEY.get(key);
    if (!step) return res.status(422).json({ message: `Unknown setup step: ${key}` });

    await setupState.mergeSetupState(businessId, (s) => {
      const dismissed = { ...s.dismissed };
      delete dismissed[key];
      return { ...s, dismissed };
    });
    await writeAudit({
      businessId, actorId: req.user.id,
      action: 'setup.step.restore', entityType: 'Business', entityId: businessId,
      meta: { key, label: step.label },
    });

    res.json(await computeCompletion(businessId, req.user));
  } catch (e) { next(e); }
}

/**
 * POST /api/hr/setup-checklist/ui — per-operator UI bookkeeping. 204, no body.
 *
 *   { widgetHiddenDays: 7 }  hide the dashboard widget until now+N days. It follows
 *                            the person across devices, which an `×` in localStorage
 *                            would not. There is no permanent dismissal.
 *   { nudgeShown: true }     the post-login nudge was rendered (lifetime cap of 5).
 *   { nudgeDismissed: true } the operator said "later" (streak cap of 3, reset by
 *                            finishing any step).
 *   { celebrated: true }     confetti has fired once; never fire it again.
 */
async function setUiState(req, res, next) {
  try {
    const { businessId } = req.user;
    const userId = req.user.id;
    if (!userId) return res.status(400).json({ message: 'No user on this session' });
    const body = req.body || {};
    const now = new Date();
    const patch = {};

    if (body.widgetHiddenDays !== undefined) {
      const days = parseInt(body.widgetHiddenDays, 10);
      if (!Number.isFinite(days) || days < 1 || days > 90) {
        return res.status(422).json({ message: 'widgetHiddenDays must be a whole number between 1 and 90.' });
      }
      patch.widgetHiddenUntil = new Date(now.getTime() + days * DAY_MS).toISOString();
    }
    if (body.celebrated === true) patch.celebratedAt = now.toISOString();

    if (body.nudgeShown === true || body.nudgeDismissed === true) {
      const state = await setupState.readSetupState(businessId);
      const ui = setupState.uiFor(state, userId);
      patch.nudgeLastShownAt = now.toISOString();
      patch.nudgeShownCount = ui.nudgeShownCount + 1;
      if (body.nudgeDismissed === true) {
        // Anchor the streak to the score it was recorded at, so the GET can reset
        // it for free the moment the operator finishes anything.
        const payload = await computeCompletion(businessId, req.user);
        const at = payload ? payload.completedCount : ui.nudgeCompletedCount;
        patch.nudgeDismissals = (ui.nudgeCompletedCount === at ? ui.nudgeDismissals : 0) + 1;
        patch.nudgeCompletedCount = at;
      }
    }

    if (Object.keys(patch).length === 0) {
      return res.status(422).json({ message: 'Nothing to update.' });
    }
    await setupState.mergeSetupState(businessId, (s) => setupState.patchUi(s, userId, patch));
    res.status(204).end();
  } catch (e) { next(e); }
}

module.exports = {
  getChecklist,
  dismissStep,
  restoreStep,
  setUiState,
  // exported for tests
  computeCompletion,
  scorePercent,
};
