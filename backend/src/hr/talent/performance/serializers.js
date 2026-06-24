'use strict';

/**
 * serializers.js — Feature 8 §5.8: CONFIDENTIALITY at the serializer level (not just
 * route level). Whoever the requester is, these strip what they must not see:
 *
 *  - Peer/360: isAnonymous → raterEmployeeId + identifying narrative removed for any
 *    requester who is the subject or the subject's manager. Only HR sees identity.
 *    Aggregates suppressed below an n≥3 floor (de-anonymisation guard).
 *  - Review instance pre-release: finalRating / managerComments / calibratedRating
 *    are ABSENT from the payload (not client-hidden) until releasedAt is set — for
 *    the subject. Managers/HR see them.
 *  - CalibrationAdjustment + MANAGER_ONLY/HR_ONLY responses NEVER serialize to the
 *    subject.
 *
 * `viewer` is one of: 'SELF' (the subject), 'MANAGER' (subject's manager-chain),
 * 'HR', 'OTHER'. Computed by the controller from the scope resolver, never trusted.
 */

const ANON_FLOOR = 3;

// Strip a review instance for a given viewer. Returns a NEW shallow object.
function serializeReviewInstance(instance, viewer) {
  if (!instance) return instance;
  const out = { ...instance };
  const released = !!instance.releasedAt;

  if (viewer === 'SELF') {
    // Pre-release: the subject must not see manager/final/calibrated figures.
    if (!released) {
      out.finalRating = null;
      out.managerComments = null;
      out.managerRating = null;
      out.calibratedRating = null;
      out.compositeScore = null;
      out.outcomeJson = null;
    } else {
      // Even released, the subject never sees the raw calibration delta.
      out.calibratedRating = null;
    }
  }
  // OTHER (out of relationship) should never reach here (route 404s first), but
  // fail-closed: blank the sensitive fields.
  if (viewer === 'OTHER') {
    out.finalRating = null;
    out.managerComments = null;
    out.managerRating = null;
    out.calibratedRating = null;
    out.selfComments = null;
  }
  return out;
}

/**
 * serializeNineBox — Feature 34 §5.8: a 9-box placement is NEVER exposed to the
 * subject. For viewer==='SELF' (the employee) the box, potential rating/band, the
 * whole move ledger, and the manager-authored development context are ABSENT from
 * the payload (not client-hidden). The subject's only window is the ESS development
 * surface (competency gaps + the IDP, and the IDP only when sharedWithSubject).
 *
 * MANAGER (the subject's manager) and HR see the full placement. OTHER (out of
 * relationship) should never reach here — the route 404s first — but we fail-closed
 * by stripping the sensitive axes for any non-MANAGER/HR viewer too.
 */
function serializeNineBox(placement, viewer) {
  if (!placement) return placement;
  const out = { ...placement };
  const privileged = viewer === 'MANAGER' || viewer === 'HR';
  if (!privileged) {
    // SELF / OTHER: the talent verdict is invisible. Keep only neutral identity +
    // the release-gated IDP (the controller decides whether to even reach this path).
    delete out.box;
    delete out.potentialRating;
    delete out.potentialBand;
    delete out.performanceBand;
    delete out.moves;
    delete out.potentialScaleId;
    // idpNote leaves only when explicitly shared; the ESS controller release-gates it.
    if (!placement.sharedWithSubject) delete out.idpNote;
  }
  return out;
}

// Filter a list of ReviewResponse rows by the viewer's visibility relationship.
function filterResponses(responses, viewer) {
  if (!Array.isArray(responses)) return [];
  return responses.filter((r) => {
    if (r.visibility === 'SHARED') return true;
    if (r.visibility === 'MANAGER_ONLY') return viewer === 'MANAGER' || viewer === 'HR';
    if (r.visibility === 'HR_ONLY') return viewer === 'HR';
    return false;
  });
}

// Serialize a peer-feedback response for the viewer. Anonymous rater identity is
// stripped for everyone except HR. Returns null-identity object.
function serializePeerResponse(response, request, viewer) {
  if (!response) return null;
  const anon = response.isAnonymous !== false;
  const out = {
    id: response.id,
    ratingsJson: response.ratingsJson,
    narrative: response.narrative,
    submittedAt: response.submittedAt,
    isAnonymous: anon,
  };
  // Only HR ever sees who the rater was when anonymous.
  if (!anon || viewer === 'HR') {
    out.raterEmployeeId = request && request.raterEmployeeId;
  }
  return out;
}

// Aggregate peer ratings with the n≥3 anonymity floor. Below the floor → suppressed.
function aggregatePeerRatings(responses) {
  const submitted = (responses || []).filter((r) => r && r.submittedAt);
  if (submitted.length < ANON_FLOOR) {
    return { suppressed: true, n: submitted.length, floor: ANON_FLOOR };
  }
  // Mean across whatever numeric values appear in ratingsJson.
  let sum = 0;
  let cnt = 0;
  for (const r of submitted) {
    const rj = r.ratingsJson;
    if (rj && typeof rj === 'object') {
      for (const v of Object.values(rj)) {
        const n = Number(v);
        if (Number.isFinite(n)) { sum += n; cnt += 1; }
      }
    }
  }
  return { suppressed: false, n: submitted.length, mean: cnt ? Math.round((sum / cnt) * 100) / 100 : null };
}

module.exports = {
  ANON_FLOOR,
  serializeReviewInstance,
  serializeNineBox,
  filterResponses,
  serializePeerResponse,
  aggregatePeerRatings,
};
