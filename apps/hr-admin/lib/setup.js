'use client';

// Setup-guide data layer — ONE fetch of GET /api/hr/setup-checklist per shell
// mount, shared by every surface (the /setup page, the dashboard widget, the
// nav badge, the post-login nudge) so those four can never disagree about the
// percentage or about which step is next.
//
// The store is a module-level singleton rather than pure React context because
// four independent subtrees consume it and only one of them (AdminShell) mounts
// the provider. Reading through `useSetup()` without a <SetupProvider> above you
// still works and still shares the same single request — the provider's only
// extra jobs are owning the one polite live region for the whole shell and
// keeping the fetch alive for surfaces that render before the page does.
//
// Refresh policy is deliberately narrow: shell mount, window focus, and an
// explicit refresh() when the operator returns from a `?from=setup` deep link.
// No polling — the "do this next" step must not change identity while someone
// is reading it.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { get, post } from '@/lib/api';

export const SETUP_ENDPOINT = '/api/hr/setup-checklist';

// A payload younger than this paints immediately (at reduced opacity) while the
// live fetch is in flight, so a slow link never shows an empty page.
const CACHE_PREFIX = 'drifthr.setup.cache.';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// window focus can fire in bursts (alt-tab, devtools, file dialogs) — collapse
// those into at most one round-trip per window.
const REFETCH_GUARD_MS = 5000;
// Long enough that a screen reader has finished the previous sentence, short
// enough that it still feels like a response to the operator's own action.
const ANNOUNCE_DEBOUNCE_MS = 500;

// Stage-panel open/closed set, remembered per tenant (the ModuleGuide idiom).
const STAGES_PREFIX = 'drifthr.setup.stages.';
const STAGES_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Store ───────────────────────────────────────────────────────────────────

const INITIAL = {
  data: null,
  loading: true,
  error: null,
  // true => `data` is the localStorage copy and a live fetch is in flight.
  stale: false,
  businessId: null,
  announcement: '',
};

let state = INITIAL;
const listeners = new Set();

function emit(patch) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot() { return state; }
// SSR + hydration always see the pristine object, so the server markup and the
// first client render agree. This is also a SECURITY boundary, for the same
// reason lib/api.js gates its cache to the browser: `state` is module scope, and
// on the server that is shared by every request in the Node process — returning
// it from a server render would hand one tenant's setup to another. Only the
// browser-only effects below ever write to it.
function getServerSnapshot() { return INITIAL; }

// ─── Tenant-scoped cache ─────────────────────────────────────────────────────

// The cache key must be the tenant, never a shared "last tenant" pointer — two
// tenants on one machine must never see each other's setup state, even for the
// one frame before the live payload lands.
let businessIdPromise = null;
function resolveBusinessId() {
  if (!businessIdPromise) {
    businessIdPromise = get('/api/auth/me')
      .then((res) => (res?.user || res)?.businessId || null)
      .catch(() => null);
  }
  return businessIdPromise;
}

function readCache(businessId) {
  if (!businessId || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CACHE_PREFIX + businessId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.at !== 'number') return null;
    if (Date.now() - parsed.at > CACHE_TTL_MS) return null;
    return parsed.data || null;
  } catch {
    return null; // private mode / corrupt entry — just fetch
  }
}

function writeCache(businessId, data) {
  if (!businessId || !data || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CACHE_PREFIX + businessId, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* quota / private mode — the cache is an optimisation, never a requirement */
  }
}

/** The tenant's remembered open stage keys (30-day TTL), or null if none. */
export function readOpenStages(businessId) {
  if (!businessId || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STAGES_PREFIX + businessId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.at !== 'number' || !Array.isArray(parsed.keys)) return null;
    if (Date.now() - parsed.at > STAGES_TTL_MS) return null;
    return parsed.keys;
  } catch {
    return null;
  }
}

export function writeOpenStages(businessId, keys) {
  if (!businessId || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STAGES_PREFIX + businessId, JSON.stringify({ at: Date.now(), keys: [...keys] }));
  } catch {
    /* ignore */
  }
}

// ─── Announcements ───────────────────────────────────────────────────────────
// One sentence carrying all three facts (what finished, the new score, what's
// next), fired only when something actually changed. Never assertive, never a
// running commentary on intermediate percentages.

let announceTimer = null;
let lastDoneKeys = null; // null until the first payload, so a cold load is silent

function doneKeysOf(data) {
  const out = new Set();
  for (const stage of data?.stages || []) {
    for (const step of stage.steps || []) if (step.state === 'done') out.add(step.key);
  }
  return out;
}

function announceFor(data, newlyDone) {
  const what = newlyDone.length === 1
    ? `${newlyDone[0]} is done.`
    : `${newlyDone.length} steps are done.`;
  const score = data.percent == null
    ? ''
    : ` Setup is now ${data.percent} percent complete.`;
  const next = data.allComplete
    ? ' Setup is complete.'
    : (data.nextAction ? ` Next: ${data.nextAction.label}.` : '');
  return `${what}${score}${next}`;
}

function updateAnnouncement(data) {
  const nextDone = doneKeysOf(data);
  const previous = lastDoneKeys;
  lastDoneKeys = nextDone;
  if (!previous) return; // first payload of the session — nothing "just happened"

  const newlyDone = [];
  for (const stage of data?.stages || []) {
    for (const step of stage.steps || []) {
      if (step.state === 'done' && !previous.has(step.key)) newlyDone.push(step.label);
    }
  }
  if (newlyDone.length === 0) return;

  if (announceTimer) clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    announceTimer = null;
    emit({ announcement: announceFor(data, newlyDone) });
  }, ANNOUNCE_DEBOUNCE_MS);
}

// ─── Loading ─────────────────────────────────────────────────────────────────

let inflight = null;
let lastFetchedAt = 0;
// Bumped by resetSetupStore(). A read that began under the previous session must
// never write its answer into the next one, so every emit below is guarded on
// the generation the read started in.
let generation = 0;

function applyPayload(data, businessId) {
  writeCache(businessId, data);
  updateAnnouncement(data);
  emit({ data, loading: false, stale: false, error: null, businessId });
}

/**
 * Fetch the checklist. Concurrent calls share one request; unforced calls
 * inside REFETCH_GUARD_MS are no-ops. Never rejects — a failure lands on
 * `state.error` and leaves any last-known payload on screen.
 */
export function loadSetup({ force = false } = {}) {
  if (inflight) return inflight;
  if (!force && lastFetchedAt && Date.now() - lastFetchedAt < REFETCH_GUARD_MS) {
    return Promise.resolve(state.data);
  }
  const began = generation;
  inflight = (async () => {
    const businessId = await resolveBusinessId();
    if (began !== generation) return null; // session ended mid-read — drop it
    // Paint the cached copy while the live read is in flight — the operator sees
    // their real numbers immediately instead of a skeleton, clearly marked as
    // being refreshed so we are never quietly showing yesterday's score.
    if (!state.data) {
      const cached = readCache(businessId);
      if (cached) emit({ data: cached, loading: false, stale: true, businessId });
      else emit({ loading: true, businessId });
    }
    try {
      const fresh = await get(SETUP_ENDPOINT);
      if (began !== generation) return null;
      lastFetchedAt = Date.now();
      applyPayload(fresh, businessId);
      return fresh;
    } catch (error) {
      if (began !== generation) return null;
      lastFetchedAt = Date.now(); // don't hammer a failing endpoint on every focus
      emit({ loading: false, stale: false, error, businessId });
      return null;
    } finally {
      // A reset already cleared this slot and a newer read may own it now.
      if (began === generation) inflight = null;
    }
  })();
  return inflight;
}

// A single window-focus listener for the whole app, attached while at least one
// consumer is mounted (refcounted so React's StrictMode double-mount is a no-op).
let consumerCount = 0;
function onWindowFocus() { loadSetup(); }

function attachConsumer() {
  consumerCount += 1;
  if (consumerCount === 1 && typeof window !== 'undefined') {
    window.addEventListener('focus', onWindowFocus);
  }
  return () => {
    consumerCount -= 1;
    if (consumerCount === 0 && typeof window !== 'undefined') {
      window.removeEventListener('focus', onWindowFocus);
    }
  };
}

/**
 * Drop everything this module remembers about the current session. MUST be
 * called at every session boundary (sign-out, and the 401 that ends a session),
 * for the same reason lib/api.js exposes invalidateApiCache().
 *
 * Both of those boundaries are CLIENT-side navigations — no page load, so this
 * module is not re-evaluated and its state would otherwise survive into whoever
 * signs in next. On a shared machine that means tenant B's console painting
 * tenant A's percentage, step list and next action, and — worse — the memoised
 * `businessIdPromise` filing tenant B's fresh payload under tenant A's cache
 * key, which A then paints on their next sign-in. The REFETCH_GUARD_MS window
 * can suppress the corrective refetch entirely, so this cannot be left to the
 * next load to fix.
 */
export function resetSetupStore() {
  generation += 1; // any read already in flight is now orphaned
  if (announceTimer) { clearTimeout(announceTimer); announceTimer = null; }
  businessIdPromise = null;
  lastDoneKeys = null;
  lastFetchedAt = 0;
  inflight = null;
  emit(INITIAL); // patch, not assignment — subscribers still mounted must re-render
}

// ─── Mutations ───────────────────────────────────────────────────────────────
// dismiss/restore return the freshly recomputed payload, so the whole UI moves
// in one step instead of flickering through a refetch.

async function postAndApply(path, body) {
  const began = generation;
  const fresh = await post(`${SETUP_ENDPOINT}${path}`, body);
  if (began !== generation) return fresh; // session ended mid-write — don't repaint
  lastFetchedAt = Date.now();
  applyPayload(fresh, state.businessId);
  return fresh;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useSetup() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => attachConsumer(), []);
  useEffect(() => { loadSetup(); }, []);

  const refresh = useCallback(() => loadSetup({ force: true }), []);
  const dismiss = useCallback((key) => postAndApply('/dismiss', { key }), []);
  const restore = useCallback((key) => postAndApply('/restore', { key }), []);
  // Per-operator UI bookkeeping (widget snooze, nudge counters, celebration).
  // Returns 204 and never changes the score, so the store is left alone.
  const setUiState = useCallback((patch) => post(`${SETUP_ENDPOINT}/ui`, patch), []);

  return {
    data: snapshot.data,
    loading: snapshot.loading,
    error: snapshot.error,
    stale: snapshot.stale,
    businessId: snapshot.businessId,
    announcement: snapshot.announcement,
    refresh,
    dismiss,
    restore,
    setUiState,
  };
}

/**
 * Mounts the shared fetch and the ONE polite live region for the shell. Every
 * setup surface announces through this region; none of them may own another.
 */
export function SetupProvider({ children }) {
  const { announcement } = useSetup();
  return (
    <>
      {children}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </>
  );
}

// ─── Copy helpers (shared so the page, widget and nudge read identically) ─────

/**
 * "The workspace is finished — stand down." The one signal that may switch off a
 * setup surface or fire a celebration.
 *
 * NOT `allComplete` on its own. That field is operator-scoped by the locked
 * percent rule: steps the operator lacks permission for leave BOTH sides of the
 * fraction, so an operator holding only `canManageCompanyProfile` (the
 * endpoint's own gate, i.e. the narrowest operator who can reach it at all) is
 * scored on three steps and hits 100% while the tenant sits at 4% with every
 * required step outstanding. Finishing your own three steps is worth saying;
 * it is not worth confetti, and it must never take the guide off their screen.
 */
export function setupFullyComplete(data) {
  return !!data && data.allComplete === true && data.tenantAllComplete === true;
}

/** The state-dependent H1 sentence. */
export function headline(data) {
  if (!data) return "Let's get your company set up";
  if (data.percent == null) return "We couldn't check your setup";
  if (data.allComplete || data.percent >= 100) {
    return setupFullyComplete(data)
      ? "You're all set"
      : "You're done — the rest needs someone else";
  }
  if (data.probeDegraded) return `You're at least ${data.percent}% set up`;
  if (data.percent <= 0) return "Let's get your company set up";
  if (data.percent >= 80) return `Almost there — ${data.percent}% set up`;
  return `You're ${data.percent}% set up`;
}

/** "18 of 44 steps done · 3 required steps left" */
export function subline(data) {
  if (!data) return '';
  if (data.percent == null) return "We couldn't check your setup just now.";
  const done = `${data.completedCount ?? 0} of ${data.totalCount ?? 0} steps done`;
  const left = data.requiredRemaining || 0;
  if (left <= 0) return done;
  return `${done} · ${left} required step${left === 1 ? '' : 's'} left`;
}

/**
 * The CTA words WITHOUT the arrow. Components that render the arrow as a
 * separate aria-hidden glyph use this, so a screen reader announces
 * "Add your people, Set up" rather than "… Set up right arrow".
 */
export function ctaVerb(step) {
  if (!step) return '';
  return step.cta
    || (step.locked ? "See what's included" : step.state === 'done' ? 'Review' : 'Set up');
}

/** "Set up →" | "Review →" | "See what's included →" */
export function ctaFor(step) {
  const label = ctaVerb(step);
  return label ? `${label} →` : '';
}

/**
 * Deep link to the real feature screen, tagged so that screen (and the shell)
 * knows the operator arrived from the guide. Preserves an existing query and an
 * existing hash — `/org#entities` must become `/org?from=setup#entities`.
 */
export function stepHref(step, { from = 'setup' } = {}) {
  const route = step?.route || '/';
  if (!from) return route;
  const hashAt = route.indexOf('#');
  const path = hashAt === -1 ? route : route.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : route.slice(hashAt);
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}from=${encodeURIComponent(from)}${hash}`;
}

/** Which stage the next-best action lives in (the one stage that auto-opens). */
export function stageOfNextAction(data) {
  return data?.nextAction?.stage || null;
}

// ─── Permission wording ──────────────────────────────────────────────────────
// Steps carry a raw rbac key. Owners and office managers do not read
// "canManageStatutory", so every key a step can declare gets one plain phrase,
// used wherever we have to say "someone else has to do this one".

const PERMISSION_PHRASES = {
  canManageCompanyProfile: 'manage your company profile',
  canManageOrg: 'manage your org structure',
  canManageEmployees: 'manage employee records',
  canManageStatutory: 'manage tax and statutory details',
  canManageRoles: 'manage roles and access',
  canManageHierarchy: 'manage the reporting tree',
  canManageApprovalWorkflows: 'manage approval chains',
  canManageAttendance: 'manage attendance',
  canManageCompensation: 'manage salaries',
  canRunPayroll: 'run payroll',
  canApprovePayroll: 'approve payroll',
  canManageImports: 'import data',
  canManageOnboarding: 'manage joining and exit checklists',
  canManageExpensePolicy: 'manage expense and travel policy',
  canManageLetters: 'manage letters',
  canManageHelpdesk: 'manage the helpdesk',
  canManageAnnouncements: 'post announcements',
  canManageRecognition: 'manage rewards and recognition',
  canManageSurveys: 'manage surveys',
  canManagePerformanceCycle: 'manage performance reviews',
  canManageLearning: 'manage training',
  canManageHiring: 'manage hiring',
  canManageSso: 'manage single sign-on',
  canEditBranding: 'edit your branding',
  canEditDomain: 'edit your web address',
  canScheduleReports: 'schedule reports',
};

/** Plain-English phrase for an rbac key, e.g. "run payroll". */
export function permissionPhrase(key) {
  return PERMISSION_PHRASES[key] || 'change this setting';
}

// ─── Row ordering ────────────────────────────────────────────────────────────

// Within an open stage: incomplete required → incomplete recommended →
// prerequisite-unmet → locked → done. Dismissed rows are handled separately
// (they live in the page footer, not in the stage).
const ROW_RANK = { required: 0, recommended: 1, blocked: 2, locked: 3, done: 4 };

function rowBucket(step) {
  if (step.state === 'done') return 'done';
  if (step.locked || step.state === 'locked') return 'locked';
  if (step.prerequisitesMet === false) return 'blocked';
  return step.required ? 'required' : 'recommended';
}

/** Stable unfinished-first ordering; declared `order` breaks every tie. */
export function orderSteps(steps) {
  return [...(steps || [])].sort((a, b) => {
    const rank = ROW_RANK[rowBucket(a)] - ROW_RANK[rowBucket(b)];
    if (rank !== 0) return rank;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}

/** Every serialised step across every stage, in declared order. */
export function allSteps(data) {
  const out = [];
  for (const stage of data?.stages || []) for (const step of stage.steps || []) out.push(step);
  return out;
}
