'use strict';

/**
 * config.js — Feature 35 R&R program switches, stored on Business.featureFlags.recognition
 * (the Feature-45 `featureFlags.expense.hrThresholdRupees` precedent — a tenant-level
 * JSON config blob needs NO new table/migration). Read via getConfig; written via
 * updateConfig (read-merge-write so sibling featureFlags keys survive).
 *
 * Switches (spec §3.7):
 *   pointsEnabled                 bool     points economy on/off. false ⇒ pure social kudos:
 *                                          every points branch no-ops (one gate, not a fork).
 *   inrPerPoint                   number   ₹ shadow per point (0 = no monetary display).
 *   recognitionApprovalThreshold  int|null totalPoints ABOVE which a give routes to F10
 *                                          manager approval. null/0 = never (default —
 *                                          behaviour-preserving for zero-config tenants).
 *   pointsExpiryMonths            int|null earned points lapse after N months (FIFO).
 *                                          null = never expire (default).
 *   redemptionRequiresApproval    bool     route redemptions through F10 (default true).
 *   peerGiveDailyCap              int      max gives per giver per day (anti-spam).
 *   perGiveMaxPoints              int      clamp on pointsEach for a single give.
 */

const prismaDefault = require('../../core/lib/prisma');

const DEFAULTS = Object.freeze({
  pointsEnabled: true,
  inrPerPoint: 0,
  recognitionApprovalThreshold: null,
  pointsExpiryMonths: null,
  redemptionRequiresApproval: true,
  peerGiveDailyCap: 10,
  perGiveMaxPoints: 500,
});

function intOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** PURE — normalise a raw featureFlags.recognition blob onto the typed defaults. */
function normaliseConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    pointsEnabled: r.pointsEnabled === undefined ? DEFAULTS.pointsEnabled : r.pointsEnabled === true,
    inrPerPoint: Number.isFinite(Number(r.inrPerPoint)) && Number(r.inrPerPoint) >= 0 ? Number(r.inrPerPoint) : DEFAULTS.inrPerPoint,
    recognitionApprovalThreshold: intOrNull(r.recognitionApprovalThreshold),
    pointsExpiryMonths: intOrNull(r.pointsExpiryMonths),
    redemptionRequiresApproval: r.redemptionRequiresApproval === undefined
      ? DEFAULTS.redemptionRequiresApproval
      : r.redemptionRequiresApproval === true,
    peerGiveDailyCap: intOrNull(r.peerGiveDailyCap) || DEFAULTS.peerGiveDailyCap,
    perGiveMaxPoints: intOrNull(r.perGiveMaxPoints) || DEFAULTS.perGiveMaxPoints,
  };
}

/** PURE — validate a PATCH body; returns { ok, patch? , error? } (only known keys). */
function validatePatch(input = {}) {
  const patch = {};
  const boolKeys = ['pointsEnabled', 'redemptionRequiresApproval'];
  for (const k of boolKeys) {
    if (input[k] !== undefined) {
      if (typeof input[k] !== 'boolean') return { ok: false, error: `${k} must be a boolean` };
      patch[k] = input[k];
    }
  }
  if (input.inrPerPoint !== undefined) {
    const n = Number(input.inrPerPoint);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'inrPerPoint must be a number >= 0' };
    patch.inrPerPoint = n;
  }
  const nullableInts = ['recognitionApprovalThreshold', 'pointsExpiryMonths'];
  for (const k of nullableInts) {
    if (input[k] !== undefined) {
      if (input[k] === null || input[k] === 0) { patch[k] = null; continue; }
      if (!Number.isInteger(input[k]) || input[k] < 0) return { ok: false, error: `${k} must be a non-negative integer or null` };
      patch[k] = input[k];
    }
  }
  const posInts = ['peerGiveDailyCap', 'perGiveMaxPoints'];
  for (const k of posInts) {
    if (input[k] !== undefined) {
      if (!Number.isInteger(input[k]) || input[k] < 1) return { ok: false, error: `${k} must be a positive integer` };
      patch[k] = input[k];
    }
  }
  return { ok: true, patch };
}

/** Read the tenant's effective R&R config (defaults applied). Fail-soft → defaults. */
async function getConfig(businessId, { tx } = {}) {
  const db = tx || prismaDefault;
  try {
    const biz = await db.business.findUnique({ where: { id: businessId }, select: { featureFlags: true } });
    const raw = biz && biz.featureFlags && typeof biz.featureFlags === 'object' ? biz.featureFlags.recognition : null;
    return normaliseConfig(raw);
  } catch (_e) {
    return normaliseConfig(null);
  }
}

/** PATCH the config (read-merge-write on featureFlags so sibling keys survive). */
async function updateConfig(businessId, input) {
  const v = validatePatch(input);
  if (!v.ok) return { error: v.error };
  const biz = await prismaDefault.business.findUnique({ where: { id: businessId }, select: { featureFlags: true } });
  if (!biz) return { notFound: true };
  const flags = biz.featureFlags && typeof biz.featureFlags === 'object' ? biz.featureFlags : {};
  const current = flags.recognition && typeof flags.recognition === 'object' ? flags.recognition : {};
  const nextRec = { ...current, ...v.patch };
  await prismaDefault.business.update({
    where: { id: businessId },
    data: { featureFlags: { ...flags, recognition: nextRec } },
  });
  return { config: normaliseConfig(nextRec) };
}

module.exports = { DEFAULTS, normaliseConfig, validatePatch, getConfig, updateConfig };
