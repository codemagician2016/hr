'use strict';

/**
 * setupState.js — read/merge helpers for the Business.setupState JSON column.
 *
 * Shape:
 *   { dismissed: { [stepKey]: { at, byUserId } },
 *     completedAt: ISO|null,
 *     ui: { [userId]: { widgetHiddenUntil, nudgeDismissals, nudgeShownCount,
 *                       nudgeLastShownAt, nudgeCompletedCount, celebratedAt } },
 *     tracks: { [trackKey]: { completedAt: ISO|null, ui: { [userId]: {…} } } } }
 *
 * The top-level `completedAt`/`ui` ARE the core track's slice — that is the shape
 * this column shipped with, and `sliceFor(state, 'core')` keeps reading it
 * bit-for-bit rather than migrating a hot JSON column. Every OTHER track (hiring,
 * and whatever comes next) lives under `tracks[key]`, so one track's completion
 * stamp and confetti can never be read as another's.
 *
 * `dismissed` deliberately stays ONE flat map: step keys are globally unique across
 * registries (checklistItems.test.js and talentChecklist.test.js both assert it), so
 * the read-modify-write below needs no per-track branch to stay correct.
 *
 * Everything writes through `mergeSetupState`, which is a read-modify-write on a
 * HOT row (Business), so it MERGES and never replaces — the same discipline as
 * entitlements.controller.js setAddOn. Two operators dismissing two different
 * steps in the same second must not clobber each other's key.
 *
 * The READ deliberately fails soft. `setupState` is an additive column; until the
 * migration has been applied on a given environment the select throws P2022, and a
 * setup GUIDE must never take the dashboard down. In that case we return the empty
 * state and log once — dismissals simply do not persist until the column lands.
 */

const prisma = require('../../core/lib/prisma');

const EMPTY = Object.freeze({ dismissed: {}, completedAt: null, ui: {}, tracks: {} });

const CORE_TRACK = 'core';

let columnWarned = false;

const asMap = (v) => ((v && typeof v === 'object' && !Array.isArray(v)) ? v : {});

/**
 * normalise REBUILDS the state object key by key, and every write goes
 * mergeSetupState → normalise → update. A branch it does not rebuild is therefore
 * DROPPED by the next write of any other branch — which is why `tracks` has to be
 * listed here: without it a core dismissal would silently erase the hiring track's
 * completion stamp (and vice versa) the first time either was written.
 */
function normalise(raw) {
  const src = asMap(raw);
  return {
    dismissed: asMap(src.dismissed),
    completedAt: src.completedAt || null,
    ui: asMap(src.ui),
    tracks: asMap(src.tracks),
  };
}

/**
 * sliceFor — one track's `{ completedAt, ui }`.
 *
 * 'core' resolves to the LEGACY top-level pair, so the shipped column keeps its
 * exact meaning and no backfill is needed; any other track resolves to its
 * namespaced slice.
 */
function sliceFor(state, trackKey = CORE_TRACK) {
  const s = state || EMPTY;
  if (!trackKey || trackKey === CORE_TRACK) {
    return { completedAt: s.completedAt || null, ui: asMap(s.ui) };
  }
  const row = asMap(asMap(s.tracks)[trackKey]);
  return { completedAt: row.completedAt || null, ui: asMap(row.ui) };
}

/**
 * patchTrack — merge a patch into ONE track's slice, leaving every other track's
 * alone. For 'core' that is a top-level merge (the legacy shape); for anything else
 * it lands under `tracks[key]`.
 */
function patchTrack(state, trackKey, patch) {
  if (!trackKey || trackKey === CORE_TRACK) return { ...state, ...patch };
  const tracks = { ...asMap(state.tracks) };
  tracks[trackKey] = { ...asMap(tracks[trackKey]), ...patch };
  return { ...state, tracks };
}

// Per-user UI bookkeeping with every field defaulted, so callers never branch on
// "has this operator ever been nudged?".
function uiFor(state, userId, trackKey = CORE_TRACK) {
  const all = sliceFor(state, trackKey).ui;
  const row = (userId && all[userId] && typeof all[userId] === 'object') ? all[userId] : {};
  return {
    widgetHiddenUntil: row.widgetHiddenUntil || null,
    nudgeDismissals: Number.isInteger(row.nudgeDismissals) ? row.nudgeDismissals : 0,
    nudgeShownCount: Number.isInteger(row.nudgeShownCount) ? row.nudgeShownCount : 0,
    nudgeLastShownAt: row.nudgeLastShownAt || null,
    // The operator's completedCount when the dismissals were last counted. When it
    // no longer matches, the operator has finished something since, and the
    // dismissal streak resets (the lifetime nudgeShownCount cap never does).
    nudgeCompletedCount: Number.isInteger(row.nudgeCompletedCount) ? row.nudgeCompletedCount : null,
    celebratedAt: row.celebratedAt || null,
  };
}

async function readSetupState(businessId) {
  try {
    const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { setupState: true } });
    return normalise(biz && biz.setupState);
  } catch (err) {
    if (!columnWarned) {
      columnWarned = true;
      console.warn(`setup-checklist: Business.setupState unreadable (${err.message}) — dismissals/celebration will not persist until the column is migrated.`);
    }
    return normalise(null);
  }
}

/**
 * mergeSetupState — read, hand the normalised state to `mutate`, write the result.
 * `mutate` may return a new object or mutate in place; either way the untouched
 * branches survive.
 */
async function mergeSetupState(businessId, mutate) {
  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { setupState: true } });
  const current = normalise(biz && biz.setupState);
  const next = mutate(current) || current;
  await prisma.business.update({ where: { id: businessId }, data: { setupState: next } });
  return next;
}

// Merge a patch into ONE operator's slice of ONE track, leaving every other
// operator's — and every other track's — alone.
function patchUi(state, userId, patch, trackKey = CORE_TRACK) {
  const ui = { ...sliceFor(state, trackKey).ui };
  ui[userId] = { ...uiFor(state, userId, trackKey), ...patch };
  return patchTrack(state, trackKey, { ui });
}

module.exports = {
  EMPTY, CORE_TRACK,
  normalise, sliceFor, patchTrack, uiFor, patchUi,
  readSetupState, mergeSetupState,
};
