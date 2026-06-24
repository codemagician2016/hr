'use strict';

/**
 * policy.js — the Attendance Capture Policy resolver + punch-time enforcement.
 *
 * RESPONSIBILITIES
 *  1. resolvePolicy(businessId, {entityId, locationId, departmentId}) — pick the
 *     MOST-SPECIFIC active AttendanceCapturePolicy for a punch context. Precedence:
 *        EMPLOYEE_GROUP (departmentId)  >  LOCATION  >  ENTITY  >  TENANT  >  none.
 *     "none" = a benign no-op policy (every mode off) so an un-configured tenant
 *     behaves EXACTLY as before this feature (geofence still runs in recompute as
 *     today — GEO_FENCE here only adds an at-punch enforce/flag on top).
 *
 *  2. enforceCapture({ policy, ip, geo, faceResult, locationCidrs, hasReference }) —
 *     given the resolved policy + the per-mode evaluations, decide:
 *        { ok, reject, reason, flags, methods, marks } where
 *        - reject:true  → the controller returns 4xx and does NOT create the punch
 *          (only when an ENFORCE mode hard-fails).
 *        - flags[]      → human-readable flag reasons to stamp on the punch
 *          (warn-mode failures land here and queue the punch for HR review).
 *        - marks        → the capture columns to persist on the AttendancePunch.
 *
 * This module does NOT touch derive.js / service.js engine math. The GEO_FENCE
 * verdict is computed by the EXISTING geo.js (evaluatePunchGeofence) — recompute
 * still owns the per-day OUT_OF_GEOFENCE surfacing; here we only add the at-punch
 * reject/flag based on the SAME geo verdict + the policy's geoEnforce lever.
 */

const prisma = require('../../../core/lib/prisma');
const { evaluatePunchGeofence } = require('../geo');
const { evaluatePunchIp } = require('./ip');
const faceMatcher = require('./faceMatcher');

// A benign "everything off" policy — the resolved default when a tenant has none.
const NULL_POLICY = Object.freeze({
  id: null,
  scope: 'NONE',
  scopeId: null,
  requireGeo: false,
  requireIp: false,
  requireFace: false,
  geoEnforce: false,
  ipEnforce: false,
  faceEnforce: false,
  faceThreshold: 0.7,
});

/**
 * resolvePolicy — return the most-specific ACTIVE policy for the context, or the
 * NULL_POLICY. Tenant-isolated by businessId. A single query loads every active
 * row for the tenant (a tiny set — at most a handful of scopes) and the precedence
 * is applied in memory, so there's no N+1 and the resolver is one round-trip.
 */
async function resolvePolicy(businessId, ctx, db = prisma) {
  if (!businessId) return { ...NULL_POLICY };
  const c = ctx || {};
  const rows = await db.attendanceCapturePolicy.findMany({
    where: { businessId, isActive: true },
    orderBy: { updatedAt: 'desc' }, // tie-break: newest wins within a scope
  });
  if (!rows.length) return { ...NULL_POLICY };

  const pick = (scope, id) => rows.find((r) => r.scope === scope && (id == null ? r.scopeId == null : r.scopeId === id));

  const resolved =
    (c.departmentId && pick('EMPLOYEE_GROUP', c.departmentId)) ||
    (c.locationId && pick('LOCATION', c.locationId)) ||
    (c.entityId && pick('ENTITY', c.entityId)) ||
    pick('TENANT', null) ||
    null;

  return resolved || { ...NULL_POLICY };
}

/**
 * loadLocationCidrs — the active office CIDR strings for a location (IP mode).
 * Empty array when the location is null or has no list (→ IP eval degrades to no-op).
 */
async function loadLocationCidrs(businessId, locationId, db = prisma) {
  if (!businessId || !locationId) return [];
  const rows = await db.locationOfficeIp.findMany({
    where: { businessId, locationId, isActive: true },
    select: { cidr: true },
  });
  return rows.map((r) => r.cidr).filter(Boolean);
}

/**
 * loadFaceReference — the employee's active enrolled reference (FACE mode).
 * Returns { hasReference, embedding } — embedding is null for the stub matcher.
 */
async function loadFaceReference(businessId, employeeId, db = prisma) {
  if (!businessId || !employeeId) return { hasReference: false, embedding: null };
  const row = await db.faceEnrollment.findFirst({
    where: { businessId, employeeId, isActive: true },
    select: { embedding: true },
  });
  return { hasReference: !!row, embedding: row ? row.embedding : null };
}

/**
 * runFaceMatch — invoke the pluggable matcher for a punch. Returns the matcher
 * verdict normalised to the FaceMatchStatus enum + a score/matched pair. When the
 * policy doesn't require FACE and no selfie was supplied → SKIPPED (no-op).
 */
async function runFaceMatch({ requireFace, liveImage, hasReference, embedding, threshold }) {
  if (!requireFace && !liveImage) {
    return { score: null, matched: null, status: 'SKIPPED', matcher: null };
  }
  if (requireFace && !liveImage) {
    // Missing required selfie — the matcher has nothing to compare; the policy
    // layer decides reject-vs-flag. Report SKIPPED so the status is honest.
    return { score: null, matched: null, status: 'SKIPPED', matcher: null };
  }
  if (requireFace && !hasReference) {
    return { score: null, matched: null, status: 'NO_REFERENCE', matcher: null };
  }
  const v = await faceMatcher.getMatcher().matchFace(embedding, liveImage, { threshold });
  // Clamp/normalise: a real matcher returns a [0,1] score + matched boolean; the
  // stub returns NEEDS_REVIEW with nulls. Re-derive matched from threshold if the
  // matcher gave a score but no explicit matched (defensive).
  let { score, matched, status } = v;
  if (score != null && matched == null && status !== 'NEEDS_REVIEW') {
    matched = score >= threshold;
    status = matched ? 'MATCHED' : 'NO_MATCH';
  }
  return { score: score == null ? null : Number(score), matched: matched == null ? null : !!matched, status, matcher: v.matcher || null };
}

/**
 * enforceCapture — the decision function. Pure given its inputs (no I/O). Builds the
 * reject/flag verdict + the punch capture marks from the policy + per-mode evals.
 *
 * @param policy        resolved AttendanceCapturePolicy (or NULL_POLICY)
 * @param geoVerdict    output of geo.evaluatePunchGeofence (or null when not run)
 * @param ipVerdict     output of ip.evaluatePunchIp (or null)
 * @param faceVerdict   output of runFaceMatch (or null)
 * @param hasSelfie     was a selfie supplied with the punch?
 * @returns { ok, reject, status, reason, flags[], methods[], marks{} }
 */
function enforceCapture({ policy, geoVerdict, ipVerdict, faceVerdict, hasSelfie }) {
  const p = policy || NULL_POLICY;
  const methods = [];
  const flags = [];
  let reject = false;
  let reason = null;

  const marks = {
    captureMethods: [],
    ipAllowed: null,
    faceMatchScore: null,
    faceMatched: null,
    faceMatchStatus: null,
    captureFlagged: false,
    captureFlagReasons: [],
  };

  // ── GEO_FENCE ──────────────────────────────────────────────────────────────
  if (p.requireGeo) {
    methods.push('GEO_FENCE');
    // geoVerdict.evaluated:false → location has no geofence or punch had no coords.
    if (geoVerdict && geoVerdict.evaluated) {
      if (geoVerdict.outOfGeofence) {
        if (p.geoEnforce) {
          reject = true;
          reason = reason || 'Punch is outside the allowed geofence';
        } else {
          flags.push('OUT_OF_GEOFENCE');
        }
      }
    } else if (geoVerdict && geoVerdict.evaluated === false && p.geoEnforce) {
      // GEO required+enforced but we couldn't evaluate (no coords / no fence config).
      // Treat a MISSING coord as a hard fail under enforce (can't prove on-site);
      // a missing FENCE CONFIG is an admin gap → flag, don't block.
      // We distinguish via geoVerdict: when the location HAS a fence but the punch
      // lacked coords, geo.js still returns evaluated:false, so we can't tell them
      // apart here — be lenient and FLAG rather than block (avoids locking out a
      // kiosk/no-GPS punch). HR sees MISSING_GEO in the queue.
      flags.push('MISSING_GEO');
    }
  }

  // ── IP_RESTRICTED ────────────────────────────────────────────────────────────
  if (p.requireIp) {
    methods.push('IP_RESTRICTED');
    if (ipVerdict && ipVerdict.evaluated) {
      marks.ipAllowed = ipVerdict.allowed;
      if (!ipVerdict.allowed) {
        if (p.ipEnforce) {
          reject = true;
          reason = reason || 'Punch is not from an approved office network';
        } else {
          flags.push('OFF_NETWORK');
        }
      }
    } else {
      // IP required but no allow-list configured for the location, or no resolvable
      // client IP → admin/config gap. Flag (don't block) so HR can fix the CIDR list.
      flags.push('IP_NOT_EVALUATED');
    }
  }

  // ── FACE ─────────────────────────────────────────────────────────────────────
  if (p.requireFace) {
    methods.push('FACE');
    if (!hasSelfie) {
      if (p.faceEnforce) {
        reject = true;
        reason = reason || 'A selfie is required to punch';
      } else {
        flags.push('FACE_MISSING_SELFIE');
      }
      marks.faceMatchStatus = 'SKIPPED';
    } else if (faceVerdict) {
      marks.faceMatchScore = faceVerdict.score;
      marks.faceMatched = faceVerdict.matched;
      marks.faceMatchStatus = faceVerdict.status;
      if (faceVerdict.status === 'NO_REFERENCE') {
        if (p.faceEnforce) {
          reject = true;
          reason = reason || 'No enrolled face on file — enroll before punching';
        } else {
          flags.push('FACE_NO_REFERENCE');
        }
      } else if (faceVerdict.status === 'NO_MATCH') {
        if (p.faceEnforce) {
          reject = true;
          reason = reason || 'Face did not match the enrolled reference';
        } else {
          flags.push('FACE_LOW_SCORE');
        }
      } else if (faceVerdict.status === 'NEEDS_REVIEW') {
        // The default stub matcher never hard-rejects: a human verifies. Always flag.
        flags.push('FACE_NEEDS_REVIEW');
      }
      // MATCHED → no flag.
    }
  } else if (hasSelfie && faceVerdict) {
    // FACE not required but a selfie was supplied (e.g. policy in transition) — store
    // the verdict for audit without flagging.
    marks.faceMatchScore = faceVerdict.score;
    marks.faceMatched = faceVerdict.matched;
    marks.faceMatchStatus = faceVerdict.status === 'SKIPPED' ? 'SKIPPED' : faceVerdict.status;
  }

  marks.captureMethods = methods;
  marks.captureFlagReasons = flags;
  marks.captureFlagged = flags.length > 0;

  return {
    ok: !reject,
    reject,
    reason,
    flags,
    methods,
    marks,
  };
}

/**
 * evaluatePunchCapture — the single high-level entry the punch controllers call.
 * Resolves the policy for the context, runs the per-mode evaluations (geo via the
 * existing geo.js, IP via ip.js, face via the pluggable matcher), and returns the
 * enforceCapture verdict. Tenant-isolated throughout.
 *
 * @param businessId
 * @param ctx  { entityId, locationId, departmentId, location } — location is the
 *             Location row (geoLat/geoLng/geofenceM/geofenceEnforce) for the geo check.
 * @param punch { geoLat, geoLng, ip, selfieDataUrl }
 * @param opts  { employeeId }  (for the FACE reference lookup)
 */
async function evaluatePunchCapture(businessId, ctx, punch, opts = {}, db = prisma) {
  const c = ctx || {};
  const pn = punch || {};
  const policy = await resolvePolicy(businessId, c, db);

  // Short-circuit: a NULL/empty policy → nothing to enforce. Still return a verdict
  // (ok:true, no marks) so the caller's wiring is uniform.
  const anyMode = policy.requireGeo || policy.requireIp || policy.requireFace;
  if (!anyMode) {
    return { ok: true, reject: false, reason: null, flags: [], methods: [], policy, marks: { captureMethods: [], captureFlagged: false, captureFlagReasons: [] } };
  }

  // GEO — reuse the EXISTING pure geofence math against the assigned location.
  let geoVerdict = null;
  if (policy.requireGeo) {
    geoVerdict = evaluatePunchGeofence(
      { geoLat: pn.geoLat, geoLng: pn.geoLng },
      c.location || null,
      {},
    );
  }

  // IP — trusted req.ip vs the location's CIDR allow-list.
  let ipVerdict = null;
  if (policy.requireIp) {
    const cidrs = await loadLocationCidrs(businessId, c.locationId, db);
    ipVerdict = evaluatePunchIp(pn.ip, cidrs);
  }

  // FACE — pluggable matcher vs the enrolled reference.
  let faceVerdict = null;
  if (policy.requireFace || pn.selfieDataUrl) {
    const ref = await loadFaceReference(businessId, opts.employeeId, db);
    faceVerdict = await runFaceMatch({
      requireFace: policy.requireFace,
      liveImage: pn.selfieDataUrl || null,
      hasReference: ref.hasReference,
      embedding: ref.embedding,
      threshold: policy.faceThreshold,
    });
  }

  const verdict = enforceCapture({
    policy,
    geoVerdict,
    ipVerdict,
    faceVerdict,
    hasSelfie: !!pn.selfieDataUrl,
  });
  return { ...verdict, policy };
}

module.exports = {
  resolvePolicy,
  loadLocationCidrs,
  loadFaceReference,
  runFaceMatch,
  enforceCapture,
  evaluatePunchCapture,
  NULL_POLICY,
};
