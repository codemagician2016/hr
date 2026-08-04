'use strict';

/**
 * setupState.js — read/merge helpers for the Business.setupState JSON column.
 *
 * Shape:
 *   { dismissed: { [stepKey]: { at, byUserId } },
 *     completedAt: ISO|null,
 *     ui: { [userId]: { widgetHiddenUntil, nudgeDismissals, nudgeShownCount,
 *                       nudgeLastShownAt, nudgeCompletedCount, celebratedAt } } }
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

const EMPTY = Object.freeze({ dismissed: {}, completedAt: null, ui: {} });

let columnWarned = false;

function normalise(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    dismissed: (src.dismissed && typeof src.dismissed === 'object') ? src.dismissed : {},
    completedAt: src.completedAt || null,
    ui: (src.ui && typeof src.ui === 'object') ? src.ui : {},
  };
}

// Per-user UI bookkeeping with every field defaulted, so callers never branch on
// "has this operator ever been nudged?".
function uiFor(state, userId) {
  const row = (userId && state.ui && state.ui[userId] && typeof state.ui[userId] === 'object') ? state.ui[userId] : {};
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

// Merge a patch into ONE operator's slice, leaving every other operator's alone.
function patchUi(state, userId, patch) {
  const ui = { ...(state.ui || {}) };
  ui[userId] = { ...uiFor(state, userId), ...patch };
  return { ...state, ui };
}

module.exports = { EMPTY, normalise, uiFor, patchUi, readSetupState, mergeSetupState };
