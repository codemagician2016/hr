'use strict';

/**
 * meritHandoff.js — Feature 8 §5.7: the LOOSE-COUPLED hand-off to F5 Compensation.
 *
 * On review.close, an instance that is `meritEligible` with a `finalRating` EMITS
 * exactly one `MeritRecommendation` (rating → % from the cycle's merit matrix).
 * Performance NEVER writes a `CompensationRevision` — F5 consumes the recommendation,
 * applies its own `canManageCompensation` + SoD, and on apply back-links
 * `compensationRevisionId`. This keeps Performance country-agnostic (F5 owns
 * currency/entity/structure). Idempotent via @@unique([businessId, reviewInstanceId]).
 *
 *   recommendedPctForRating(rating, matrixJson) — pure lookup.
 *   emitMeritRecommendation(tx, { instance, cycle, actorId }) — upsert one row.
 */

const { num } = require('./goalRollup');
const { writeAudit } = require('../../../core/lib/audit');

// Resolve the recommended merit % from a rating using the cycle's matrix. Matrix
// shapes supported: { "5": 12, "4": 8, ... } (exact rating bucket) or
// { bands:[{min,max,pct}] }. Falls back to 0 when no match.
function recommendedPctForRating(rating, matrixJson) {
  if (rating == null || !matrixJson) return 0;
  const r = num(rating);
  if (Array.isArray(matrixJson.bands)) {
    for (const b of matrixJson.bands) {
      const lo = num(b.min);
      const hi = b.max == null ? Infinity : num(b.max);
      if (r >= lo && r <= hi) return num(b.pct);
    }
    return 0;
  }
  // Exact-bucket map keyed by integer rating; also try the floor.
  const exact = matrixJson[String(r)] ?? matrixJson[String(Math.round(r))] ?? matrixJson[String(Math.floor(r))];
  return num(exact);
}

/**
 * Emit (idempotent) a MeritRecommendation for a closed, merit-eligible instance.
 * Runs inside the caller's tx. Returns the row or null (not eligible / no rating).
 */
async function emitMeritRecommendation(tx, { instance, cycle, actorId }) {
  if (!instance) return null;
  if (!instance.meritEligible || instance.finalRating == null) return null;

  const recommendedPct = recommendedPctForRating(instance.finalRating, cycle && cycle.meritMatrixJson);

  // Upsert keyed on the unique (businessId, reviewInstanceId) so a re-close /
  // re-run never double-mints (QA10 idempotency).
  const existing = await tx.meritRecommendation.findFirst({
    where: { businessId: instance.businessId, reviewInstanceId: instance.id },
    select: { id: true, status: true },
  });
  if (existing) return existing;

  const row = await tx.meritRecommendation.create({
    data: {
      businessId: instance.businessId,
      reviewInstanceId: instance.id,
      subjectEmployeeId: instance.employeeId,
      cycleId: instance.reviewCycleId,
      finalRating: instance.finalRating,
      compositeScore: instance.compositeScore != null ? instance.compositeScore : num(instance.finalRating),
      proRationFactor: instance.proRationFactor != null ? instance.proRationFactor : 1,
      recommendedPct,
      status: 'PENDING',
    },
  });
  await writeAudit({
    businessId: instance.businessId,
    actorId,
    action: 'merit.recommend',
    entityType: 'MeritRecommendation',
    entityId: row.id,
    meta: { reviewInstanceId: instance.id, subjectEmployeeId: instance.employeeId, finalRating: String(instance.finalRating), recommendedPct },
  });
  return row;
}

module.exports = { recommendedPctForRating, emitMeritRecommendation };
